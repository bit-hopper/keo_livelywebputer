module("lively.data.ImageUpload")
  .requires("lively.data.FileUpload")
  .toRun(function () {
    lively.data.FileUpload.Handler.subclass("lively.Clipboard.ImageUploader", {
      uploadThreshold: 1024 * 1024 * 60, // 60MB

      handles: function (file) {
        return file.type.match(/image\/.*/);
      },

      htmlWrapsImage: function (evt) {
        // when dropping images from one browser page to another we receive a
        // drop event with an item. The item has the mime type html, even if an
        // image and not a whole DOM selection was dragged&dropped. However, in
        // those cases only the image element is the only meaningful element.
        // This method recognizes that.
        var elems = this.getHTMLElementsFromDataTransfer(evt);
        return (
          elems.length === 1 &&
          elems[0].tagName &&
          elems[0].tagName.toUpperCase() === "IMG"
        );
      },

      getHTMLElementsFromDataTransfer: function (evt) {
        var content = evt.dataTransfer.getData("text/html");
        return content
          ? lively.$.parseHTML(content).filter(function (el) {
              return el.tagName !== "META";
            })
          : null;
      },

      handlesItems: function (items, evt) {
        var content = evt.dataTransfer && evt.dataTransfer.getData("text/html");
        return content && this.htmlWrapsImage(evt);
      },

      handleItems: function (items, evt) {
        var elems = this.getHTMLElementsFromDataTransfer(evt);
        if (!elems || !elems[0]) {
          console.warn("No HTML elements found in data transfer");
          return;
        }
        var el = elems[0];
        var src = el.getAttribute("src");
        this.openImage(src, null, evt.getPosition());
      },

      readManually: function (file) {
        var self = this;

        function _openAndFit(url, type) {
          var img = self.openImage(url, type, self.pos, file.name, function (err, loadedImg) {
            var m = loadedImg || img;
            if (!m) return;
            var tryExtent = function () {
              try { m.setNativeExtent(); } catch (e) { setTimeout(tryExtent, 100); }
            };
            setTimeout(tryExtent, 100);
          });
          // Attach synchronously from the return value — don't wait for the load callback,
          // which may receive (img) instead of (null, img) depending on the Image class.
          if (img) self.attachIdentityDelete(img, url);
        }

        if (self.isIdentityUploadAvailable()) {
          self.identityUpload(file, function (err, url) {
            if (err) { $world.inform("Error uploading image file:\n" + err); return; }
            _openAndFit(url, file.type);
          });
          return;
        }

        lively.lang.fun.composeAsync(
          function (n) {
            lively.data.FileUpload.uploadFilesToServer([file], self.evt, false, n);
          },
          function (report, n) {
            if (!report || !report.uploadedFiles || !report.uploadedFiles[0]) {
              return n(new Error("no file uploaded or invalid upload response. Response: " + JSON.stringify(report)));
            }
            var uploaded = report.uploadedFiles[0],
              relPath = uploaded && uploaded.relativePath;
            if (!relPath) return n(new Error("no file uploaded?"));
            var img = self.openImage(
              URL.root.withPath("/" + relPath).toString(),
              uploaded.type, self.pos, file.name, n);
          },
          function (img, n) {
            var attemptSetNativeExtent = function () {
              try { img.setNativeExtent(); n(); }
              catch (e) { setTimeout(attemptSetNativeExtent, 100); }
            };
            setTimeout(attemptSetNativeExtent, 100);
          },
        )(function (err) {
          if (err) $world.inform("Error uploading image file:\n" + err);
        });
      },

      getUploadSpec: function (evt, file) {
        // var altDown = evt.isAltDown();
        // return {readMethod: altDown ? "asBinary" : 'asDataURL'};
        return { readMethod: "manual" };
      },

      onLoad: function (evt) {
        if (this.readMethod === "asBinary") {
          this.uploadAndOpenImageTo(
            URL.source.withFilename(this.file.name),
            this.file.type,
            evt.target.result,
            this.pos,
          );
        } else {
          if (
            typeof evt.total == "number" &&
            evt.total > this.uploadThreshold
          ) {
            var size = Numbers.humanReadableByteSize(evt.total);
            $world.confirm(
              "WARNING: Uploaded file is rather big (" +
                size +
                ").\n" +
                "Do you want to continue uploading?",
              function (result) {
                if (result === 0)
                  this.openImage(
                    evt.target.result,
                    this.file.type,
                    this.pos,
                    this.file.name,
                  );
              }.bind(this),
              ["Yes", "No"],
            );
          } else
            this.openImage(
              evt.target.result,
              this.file.type,
              this.pos,
              this.file.name,
            );
        }
      },

      uploadAndOpenImageTo: function (url, mime, binaryData, pos) {
        var openImage = this.openImage.bind(this, url, mime, pos);
        var webR = this.uploadBinary(url, mime, binaryData, function (status) {
          if (!status.isDone()) return;
          if (status.isSuccess()) openImage();
          else alert("Failure uploading " + url + ": " + status);
        });
      },

      openImage: function (url, mime, pos, optName, thenDo) {
        var name = optName;
        if (!name)
          try {
            name = new URL(url).filename();
          } catch (e) {
            name = "image";
          }
        var w = lively.morphic.World.current();
        var maxExt = w.visibleBounds().extent().addXY(-20, -20);
        var opts = {
          useNativeExtent: true,
          maxWidth: maxExt.x,
          maxHeight: maxExt.y,
        };
        // Start with 0x0 extent to trigger automatic native extent calculation
        var img = new lively.morphic.Image(
          pt(0, 0).extent(pt(0, 0)),
          url,
          opts,
          thenDo,
        ).openInWorld();
        img.name = name;
        pos && img.setPosition(pos);
        return img;
      },
    });
  }); // end of module
