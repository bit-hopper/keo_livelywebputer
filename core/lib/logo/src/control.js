// Control structures and template-based iteration (LOGO.md 4.1, 5.3; manual, CONTROL STRUCTURES and TEMPLATE-BASED
// ITERATION). Everything here is a machine operation (prims.js): it arranges frames and returns PENDING, or completes a
// value itself. None of these call back into the interpreter from JS, which is what keeps STOP, OUTPUT, THROW, deep
// recursion and Stop-button interruption working through them (LOGO.md 5.3).
//
// STOP and OUTPUT leave the enclosing PROCEDURE through every one of these constructs (LOGO.md decision 14): REPEAT,
// FOREVER, IF, IFELSE, RUN, CATCH, APPLY, FOREACH, FOR, WHILE ... That is what the manual and the books specify. The
// 6.2.5 reference binary stops only the construct for REPEAT, FOREVER, CATCH, APPLY and FOREACH (upstream issues #137 and
// #226); we do not reproduce that.

import {
  Cell, NIL, LArray, isList, isWord, wordText, nameKey, listFromArray, listToArray, equalp,
} from './data.js';
import { err, LogoError } from './errors.js';
import { showForm, printText } from './printer.js';
import { int, num, tf, bool } from './prims.js';
import {
  NO, VALUE, EITHER, PENDING, CBFrame, CatchFrame, RunResultFrame, TemplateFrame, ByeSignal, tfOf, ProcFrame,
} from './machine.js';

// The members of a datum as an iteration sequence (FOREACH, MAP ...): a list's members, a word's characters, an array's
// items. `rest(k)` is the part of the data after item k, which ?REST names.
function toSeq(x, who) {
  if (isList(x)) {
    const items = [], cells = [];
    for (let c = x; c instanceof Cell; c = c.rest) { items.push(c.first); cells.push(c); }
    return { items, kind: 'list', rest: (k) => cells[k].rest };
  }
  if (x instanceof LArray) return { items: x.items.slice(), kind: 'array', rest: (k) => listFromArray(x.items.slice(k + 1)) };
  if (isWord(x)) {
    const cs = Array.from(wordText(x));
    return { items: cs, kind: 'word', rest: (k) => cs.slice(k + 1).join('') };
  }
  throw err.badType(who, showForm(x));
}

// Runs `tpl` once per position of the (parallel) sequences. onResult(k, value) sees each template result and may return
// true to stop early; onDone(m) runs when the sequences are exhausted (or onResult stopped). The template is applied
// under (tplWant, blame); `who` names the primitive for messages.
function iterate(m, seqs, tpl, who, tplWant, blame, onResult, onDone) {
  const n = seqs[0].items.length;
  for (const s of seqs) if (s.items.length !== n) throw err.badType(who, showForm(listFromArray(s.items)));
  let k = 0;
  let frame;
  const next = (mm) => {
    if (k >= n) { onDone(mm); return; }
    const idx = k++;
    mm.stack.push(frame);
    mm.applyTemplate(tpl, seqs.map((s) => s.items[idx]), tplWant, blame, who, idx + 1, () => seqs.map((s) => s.rest(idx)));
  };
  frame = new CBFrame((mm, v) => {
    if (onResult(k - 1, v) === true) { onDone(mm); return; }
    next(mm);
  });
  next(m);
}

// A number input given as "a word or list evaluated as by RUN" (FOR's control list): a numeric word is its own value.
function evalNumber(m, x, who, k) {
  if (isWord(x)) {
    const t = wordText(x);
    if (t !== '' && !Number.isNaN(Number(t)) && /^[-+.\d]/.test(t)) { k(num(x, who)); return; }
  }
  m.stack.push(new CBFrame((mm, v) => k(num(v, who))));
  m.runList(x, VALUE, who, null, who);
}

export function install(P) {
  // ---- running lists -----------------------------------------------------------------------------------------------
  P.op('run', 1, (m, a, want, blame, tail) => { m.runList(a[0], want, blame, tail, 'run'); return PENDING; });

  P.op('runresult', 1, (m, a, want, blame) => {
    m.stack.push(new RunResultFrame(want, blame));
    m.runList(a[0], EITHER, 'runresult', null, 'runresult');
    return PENDING;
  });

  const loopCount = (a, who) => {
    const n = int(a[0], who);
    if (n < 0) throw err.badValue(who, showForm(a[0]));
    return n;
  };
  P.op('repeat', 2, (m, a, want, blame) => {
    if (want === VALUE) throw err.notOutput('repeat', blame);
    m.repeatList(loopCount(a, 'repeat'), a[1]);
    return PENDING;
  });
  P.op('forever', 1, (m, a, want, blame) => {
    if (want === VALUE) throw err.notOutput('forever', blame);
    m.repeatList(-1, a[0]);
    return PENDING;
  });
  P.fn('repcount', 0, (a, m) => m.repcount);
  // # is the position in a template's data while a template is running, else REPEAT's count (manual, REPCOUNT).
  P.fn('#', 0, (a, m) => (m.slots !== null && m.slots.index !== undefined ? m.slots.index : m.repcount));

  // ---- conditionals ------------------------------------------------------------------------------------------------
  P.op('if', 2, (m, a, want, blame, tail) => {
    m.evalTf(a[0], 'if', (b) => {
      if (b) m.runList(a[1], want, blame, tail, 'if');
      else if (a.length > 2) m.runList(a[2], want, blame, tail, 'if');
      else m.complete(undefined, want, blame, 'if');
    });
    return PENDING;
  }, { min: 2, max: 3 });

  P.op('ifelse', 3, (m, a, want, blame, tail) => {
    m.evalTf(a[0], 'ifelse', (b) => m.runList(b ? a[1] : a[2], want, blame, tail, 'ifelse'));
    return PENDING;
  });

  P.op('test', 1, (m, a, want, blame) => {
    m.evalTf(a[0], 'test', (b) => { m.setTest(b); m.complete(undefined, want, blame, 'test'); });
    return PENDING;
  });
  const ifTest = (name, wanted) => (m, a, want, blame, tail) => {
    const t = m.getTest();
    if (t === undefined) throw err.noTest(name);
    if (t === wanted) m.runList(a[0], want, blame, tail, name);
    else m.complete(undefined, want, blame, name);
    return PENDING;
  };
  P.op('iftrue ift', 1, ifTest('iftrue', true));
  P.op('iffalse iff', 1, ifTest('iffalse', false));

  // ---- leaving a procedure -----------------------------------------------------------------------------------------
  P.op('stop', 0, (m, a, want, blame) => {
    if (want === VALUE) throw err.notOutput('stop', blame);
    const fi = m.nearestProc('stop');
    if (fi < 0) throw err.onlyInProc('stop');
    m.unwindToProc(m.stack[fi], undefined);
    return PENDING;
  });
  // OUTPUT / .MAYBEOUTPUT as SYNTAX are the machine's special forms (so the input is evaluated in tail position); this
  // `op` is what runs when one is reached some other way, e.g. APPLY "OUTPUT [3].
  const outputOp = (name) => (m, a) => {
    const fi = m.nearestProc(name);
    if (fi < 0) throw err.onlyInProc(name);
    m.unwindToProc(m.stack[fi], a[0]);
    return PENDING;
  };
  P.op('output op', 1, outputOp('output'), { special: 'output' });
  P.op('.maybeoutput', 1, outputOp('.maybeoutput'), { special: 'maybeoutput' });

  // ---- non-local exit ----------------------------------------------------------------------------------------------
  P.op('catch', 2, (m, a, want, blame) => {
    if (!isWord(a[0])) throw err.badType('catch', showForm(a[0]));
    m.stack.push(new CatchFrame(nameKey(wordText(a[0])), want, blame));
    m.runList(a[1], want, blame, null, 'catch');
    return PENDING;
  });

  P.op('throw', 1, (m, a) => {
    if (!isWord(a[0])) throw err.badType('throw', showForm(a[0]));
    const key = nameKey(wordText(a[0]));
    if (key === 'error') {
      // THROW "ERROR raises an error condition. With a second input that input is the message, and the error is
      // reported at the place the procedure containing the THROW was CALLED from (manual), so a user procedure can fail
      // as if it were a primitive.
      const e = a.length > 1 ? err.user(printText(a[1])) : new LogoError(21, 'Throw "Error');
      if (a.length > 1) {
        e.located = true;
        let seen = 0;
        for (let k = m.stack.length - 1; k >= 0; k--) {
          const f = m.stack[k];
          if (f instanceof ProcFrame && ++seen === 2) { e.proc = f.proc.name; e.line = f.line; break; }
        }
      }
      throw e;
    }
    m.doThrow(key, a.length > 1 ? a[1] : undefined);
    return PENDING;
  }, { min: 1, max: 2 });

  P.fn('error', 0, (a, m) => { const e = m.lastError; m.lastError = NIL; return e; });
  P.fn('bye', 0, () => { throw new ByeSignal(0); });
  // WAIT n: delay n/60 s. A cell cannot block its worker, so Phase 1 accepts the input and does not delay; the cell's
  // "instant" mode is the default (LOGO.md 6.3).
  P.fn('wait', 1, (a) => { num(a[0], 'wait'); });
  P.fn('ignore', 1, () => undefined);
  P.fn('to', 0, () => { throw err.toInside(); }, { min: 0, max: -1 });

  // ---- slots -------------------------------------------------------------------------------------------------------
  // ? and (? n): the template's data. ?REST and (?REST n): the data to the right of the current item.
  P.fn('?', 0, (a, m) => {
    const s = m.slots;
    if (s === null) throw err.noValue('?');
    const k = a.length ? int(a[0], '?') : 1;
    if (k < 1 || k > s.args.length) throw err.badValue('?', showForm(a[0]));
    return s.args[k - 1];
  }, { min: 0, max: 1 });
  P.fn('?rest', 0, (a, m) => {
    const s = m.slots;
    if (s === null || !s.rest) throw err.noValue('?rest');
    const k = a.length ? int(a[0], '?rest') : 1;
    const rests = s.rest();
    if (k < 1 || k > rests.length) throw err.badValue('?rest', showForm(a[0]));
    return rests[k - 1];
  }, { min: 0, max: 1 });

  // ---- APPLY / INVOKE ----------------------------------------------------------------------------------------------
  P.op('apply', 2, (m, a, want, blame) => {
    if (!isList(a[1])) throw err.badType('apply', showForm(a[1]));
    m.applyTemplate(a[0], listToArray(a[1]), want, blame, 'apply');
    return PENDING;
  });
  P.op('invoke', 2, (m, a, want, blame) => {
    m.applyTemplate(a[0], a.slice(1), want, blame, 'invoke');
    return PENDING;
  }, { min: 1, max: -1 });

  // ---- iteration over data -----------------------------------------------------------------------------------------
  P.op('foreach', 2, (m, a, want, blame) => {
    if (want === VALUE) throw err.notOutput('foreach', blame);
    const tpl = a[a.length - 1];
    const seqs = a.slice(0, -1).map((x) => toSeq(x, 'foreach'));
    iterate(m, seqs, tpl, 'foreach', NO, 'foreach', () => {}, (mm) => mm.complete(undefined, want, blame, 'foreach'));
    return PENDING;
  }, { min: 2, max: -1 });

  P.op('map', 2, (m, a, want, blame) => {
    const tpl = a[0];
    const seqs = a.slice(1).map((x) => toSeq(x, 'map'));
    const out = [];
    iterate(m, seqs, tpl, 'map', VALUE, 'map', (k, v) => { out.push(v); }, (mm) => {
      if (seqs[0].kind === 'word') {
        let s = '';
        for (const x of out) { if (!isWord(x)) throw err.badType('map', showForm(x)); s += wordText(x); }
        mm.complete(s, want, blame, 'map');
      } else mm.complete(listFromArray(out), want, blame, 'map');
    });
    return PENDING;
  }, { min: 2, max: -1 });

  P.op('map.se', 2, (m, a, want, blame) => {
    const tpl = a[0];
    const seqs = a.slice(1).map((x) => toSeq(x, 'map.se'));
    const out = [];
    iterate(m, seqs, tpl, 'map.se', VALUE, 'map.se', (k, v) => {
      if (isList(v)) for (let c = v; c instanceof Cell; c = c.rest) out.push(c.first); else out.push(v);
    }, (mm) => mm.complete(listFromArray(out), want, blame, 'map.se'));
    return PENDING;
  }, { min: 2, max: -1 });

  P.op('filter', 2, (m, a, want, blame) => {
    const seq = toSeq(a[1], 'filter');
    const kept = [];
    iterate(m, [seq], a[0], 'filter', VALUE, 'filter', (k, v) => { if (tfOf(v, 'filter')) kept.push(seq.items[k]); }, (mm) => {
      mm.complete(seq.kind === 'word' ? kept.join('') : listFromArray(kept), want, blame, 'filter');
    });
    return PENDING;
  });

  P.op('find', 2, (m, a, want, blame) => {
    const seq = toSeq(a[1], 'find');
    let found = seq.kind === 'word' ? '' : NIL;
    iterate(m, [seq], a[0], 'find', VALUE, 'find', (k, v) => {
      if (tfOf(v, 'find')) { found = seq.items[k]; return true; }
    }, (mm) => mm.complete(found, want, blame, 'find'));
    return PENDING;
  });

  // REDUCE folds from the right: the template first gets the last two items, then the next one to the left and the
  // result so far (manual; checked: reduce [?1 - ?2] [10 3 2] is 9).
  P.op('reduce', 2, (m, a, want, blame) => {
    const seq = toSeq(a[1], 'reduce');
    const items = seq.items;
    if (items.length === 0) throw err.badType('reduce', showForm(a[1]));
    let acc = a.length > 2 ? a[2] : items[items.length - 1];
    let i = a.length > 2 ? items.length - 1 : items.length - 2;
    const step = (mm) => {
      if (i < 0) { mm.complete(acc, want, blame, 'reduce'); return; }
      const x = items[i--];
      mm.stack.push(new CBFrame((m2, v) => { acc = v; step(m2); }));
      mm.applyTemplate(a[0], [x, acc], VALUE, 'reduce', 'reduce', undefined, undefined);
    };
    step(m);
    return PENDING;
  }, { min: 2, max: 3 });

  // CROSSMAP: every combination of the data lists, the first list varying slowest.
  P.op('crossmap', 2, (m, a, want, blame) => {
    const tpl = a[0];
    let lists = a.slice(1);
    if (lists.length === 1) lists = listToArray(lists[0]);
    const seqs = lists.map((x) => toSeq(x, 'crossmap'));
    const combos = [];
    const build = (d, cur) => {
      if (d === seqs.length) { combos.push(cur.slice()); return; }
      for (const x of seqs[d].items) { cur.push(x); build(d + 1, cur); cur.pop(); }
    };
    build(0, []);
    const out = [];
    let k = 0;
    const frame = new CBFrame((mm, v) => { out.push(v); next(mm); });
    const next = (mm) => {
      if (k >= combos.length) { mm.complete(listFromArray(out), want, blame, 'crossmap'); return; }
      const args = combos[k++];
      mm.stack.push(frame);
      mm.applyTemplate(tpl, args, VALUE, 'crossmap', 'crossmap', k);
    };
    next(m);
    return PENDING;
  }, { min: 2, max: -1 });

  // CASCADE endtest tmp1 sv1 [tmp2 sv2 ...] [final]   (and CASCADE.2, whose default is 5 inputs)
  const cascade = (who) => (m, a, want, blame) => {
    const endtest = a[0];
    const pairs = Math.floor((a.length - 1) / 2);
    const final = a.length % 2 === 0 ? a[a.length - 1] : null;
    const tpls = [], vals = [];
    for (let j = 0; j < pairs; j++) { tpls.push(a[1 + 2 * j]); vals.push(a[2 + 2 * j]); }
    let count = 0;
    let current = vals.slice();
    const finish = (mm) => {
      if (final !== null) {
        mm.applyTemplate(final, current, want, blame, who, count);
      } else mm.complete(current[0], want, blame, who);
    };
    const round = (mm) => {
      // Apply every template to the current values, in order, to get the next values.
      const next = [];
      let j = 0;
      const stepj = (m2) => {
        if (j >= tpls.length) { current = next; count++; loop(m2); return; }
        const t = tpls[j++];
        m2.stack.push(new CBFrame((m3, v) => { next.push(v); stepj(m3); }));
        m2.applyTemplate(t, current, VALUE, who, who, count + 1);
      };
      stepj(mm);
    };
    const loop = (mm) => {
      if (isWord(endtest) && !isNaN(Number(wordText(endtest))) && wordText(endtest) !== '') {
        if (count >= int(endtest, who)) finish(mm); else round(mm);
        return;
      }
      mm.stack.push(new CBFrame((m2, v) => { if (tfOf(v, who)) finish(m2); else round(m2); }));
      mm.applyTemplate(endtest, current, VALUE, who, who, count + 1);
    };
    loop(m);
    return PENDING;
  };
  P.op('cascade', 3, cascade('cascade'), { min: 3, max: -1 });
  P.op('cascade.2', 5, cascade('cascade.2'), { min: 5, max: 5 });

  // TRANSFER endtest template inbasket: each member of the inbasket is ?IN in turn and the previous result is ?OUT.
  P.fn('?in', 0, (a, m) => { if (m.slots === null || !m.slots.named) throw err.noValue('?in'); return m.slots.named.inValue; });
  P.fn('?out', 0, (a, m) => { if (m.slots === null || !m.slots.named) throw err.noValue('?out'); return m.slots.named.outValue; });
  P.op('transfer', 3, (m, a, want, blame) => {
    const endtest = a[0], tpl = a[1];
    const basket = listToArray(a[2]);
    let out = NIL, k = 0;
    const step = (mm) => {
      if (k >= basket.length) { mm.complete(out, want, blame, 'transfer'); return; }
      const named = { inValue: basket[k], outValue: out };
      const apply = () => {
        mm.stack.push(new CBFrame((m2, v) => { out = v; k++; step(m2); }));
        mm.applyTemplate(tpl, [], VALUE, 'transfer', 'transfer', k + 1, undefined, named);
      };
      if (endtest === NIL) { apply(); return; }
      mm.stack.push(new CBFrame((m2, v) => { if (tfOf(v, 'transfer')) m2.complete(out, want, blame, 'transfer'); else apply(); }));
      mm.applyTemplate(endtest, [], VALUE, 'transfer', 'transfer', k + 1, undefined, named);
    };
    step(m);
    return PENDING;
  });

  // ---- FOR / WHILE / UNTIL / DO.WHILE / DO.UNTIL -------------------------------------------------------------------
  P.op('for', 2, (m, a, want, blame) => {
    if (want === VALUE) throw err.notOutput('for', blame);
    const ctl = listToArray(a[0]);
    if (ctl.length < 3 || ctl.length > 4 || !isWord(ctl[0])) throw err.badType('for', showForm(a[0]));
    const key = nameKey(wordText(ctl[0]));
    evalNumber(m, ctl[1], 'for', (start) => {
      evalNumber(m, ctl[2], 'for', (limit) => {
        const go = (step) => {
          // The loop variable is local to the FOR: a scope, released when the loop ends or is unwound.
          const scopeFrame = new TemplateFrame(m.slots, { names: [] }, m.scope);
          m.scope = scopeFrame.scope;
          m.bindVar(key, start);
          m.stack.push(scopeFrame);
          let i = start;
          const body = new CBFrame((mm) => {
            i += step;
            iter(mm);
          });
          const iter = (mm) => {
            if (step > 0 ? i > limit : i < limit) {
              mm.stack.pop();           // the scope frame
              scopeFrame.release(mm);
              mm.complete(undefined, want, blame, 'for');
              return;
            }
            mm.setVar(key, i);
            mm.stack.push(body);
            mm.runList(a[1], NO, 'for', null, 'for');
          };
          iter(m);
        };
        if (ctl.length === 4) evalNumber(m, ctl[3], 'for', go);
        else go(limit >= start ? 1 : -1);
      });
    });
    return PENDING;
  });

  // while / until: test first; do.while / do.until: body first.
  const whileLike = (who, testFirst, continueWhen) => (m, a, want, blame) => {
    if (want === VALUE) throw err.notOutput(who, blame);
    const testExpr = testFirst ? a[0] : a[1];
    const body = testFirst ? a[1] : a[0];
    const bodyFrame = new CBFrame((mm) => testLoop(mm));
    const runBody = (mm) => {
      mm.stack.push(bodyFrame);
      mm.runList(body, NO, who, null, who);
    };
    const testLoop = (mm) => {
      mm.evalTf(testExpr, who, (b) => {
        if (b === continueWhen) runBody(mm); else mm.complete(undefined, want, blame, who);
      });
    };
    if (testFirst) testLoop(m); else runBody(m);
    return PENDING;
  };
  P.op('while', 2, whileLike('while', true, true));
  P.op('until', 2, whileLike('until', true, false));
  P.op('do.while', 2, whileLike('do.while', false, true));
  P.op('do.until', 2, whileLike('do.until', false, false));

  // ---- CASE / COND -------------------------------------------------------------------------------------------------
  P.op('case', 2, (m, a, want, blame) => {
    const value = a[0];
    const clauses = listToArray(a[1]);
    for (const c of clauses) {
      if (!(c instanceof Cell)) throw err.badType('case', showForm(c));
      const head = c.first;
      const isElse = isWord(head) && wordText(head).toLowerCase() === 'else';
      if (isElse || (isList(head) && listToArray(head).some((x) => equalp(x, value)))) {
        m.runList(c.rest, want, blame, null, 'case');
        return PENDING;
      }
    }
    return undefined;
  });

  P.op('cond', 1, (m, a, want, blame) => {
    const clauses = listToArray(a[0]);
    let i = 0;
    const step = (mm) => {
      while (i < clauses.length) {
        const c = clauses[i++];
        if (!(c instanceof Cell)) throw err.badType('cond', showForm(c));
        const head = c.first;
        if (isWord(head) && wordText(head).toLowerCase() === 'else') { mm.runList(c.rest, want, blame, null, 'cond'); return; }
        mm.evalTf(head, 'cond', (b) => { if (b) mm.runList(c.rest, want, blame, null, 'cond'); else step(mm); });
        return;
      }
      mm.complete(undefined, want, blame, 'cond');
    };
    step(m);
    return PENDING;
  });
}
