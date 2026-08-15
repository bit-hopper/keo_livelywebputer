// AudioWorkletProcessor for femtoBoy.
// Receives batches of int16 mono samples (at 44100Hz) via port.postMessage
// from the main thread (one batch per emulated video frame) and drains them
// into a small ring buffer that process() reads from at the audio clock's
// own pace. Decoupling producer/consumer this way absorbs the jitter between
// requestAnimationFrame and the audio render quantum without any special
// cross-origin-isolation requirements (no SharedArrayBuffer).

class FemtoBoyAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ring = new Float32Array(44100 * 2); // ~2s capacity
    this._writePos = 0;
    this._readPos = 0;
    this._available = 0;
    this._muted = false;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'mute') {
        this._muted = !!msg.value;
        return;
      }
      if (msg.type === 'samples') {
        this._push(msg.samples);
      }
    };
  }

  _push(int16Samples) {
    const ring = this._ring;
    const cap = ring.length;
    for (let i = 0; i < int16Samples.length; i++) {
      ring[this._writePos] = int16Samples[i] / 32768;
      this._writePos = (this._writePos + 1) % cap;
      if (this._available < cap) {
        this._available++;
      } else {
        // overflowed: drop oldest sample by advancing read pointer
        this._readPos = (this._readPos + 1) % cap;
      }
    }
  }

  process(inputs, outputs) {
    const output = outputs[0][0];
    if (!output) return true;
    const ring = this._ring;
    const cap = ring.length;
    for (let i = 0; i < output.length; i++) {
      if (this._available > 0 && !this._muted) {
        output[i] = ring[this._readPos];
        this._readPos = (this._readPos + 1) % cap;
        this._available--;
      } else {
        output[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('femtoboy-audio-processor', FemtoBoyAudioProcessor);
