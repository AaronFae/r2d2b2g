/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

debug("loading window_manager tweaks.");

Cu.import("resource://prosthesis/modules/GlobalSimulatorScreen.jsm");
Cu.import("resource://prosthesis/modules/B2GAgentSheet.jsm");

navigator.mozSettings
  .createLock().set({'homescreen.ready': false});

let SimulatorWindowManager = {
  init: function() {
    this._initObservers();
    this._initKeepWindowSize();
    this._initMutationObservers();
    this._adjustWindowSize(GlobalSimulatorScreen.width,
                           GlobalSimulatorScreen.height);
  },
  get _homescreen() shell.contentBrowser.contentWindow.wrappedJSObject,
  get _shellElement() document.getElementById("shell"),
  get _homescreenElement() document.getElementById("homescreen"),
  get _rotateButtonElement() document.getElementById("rotateButton"),
  get _toolboxHeight() document.querySelector("toolbox").clientHeight,
  _fixSizeInStyle: function(width, height) {
    return ["width: ", width, "px;",
            "min-width: ", width, "px;",
            "max-width: ", width, "px;",
            "height: ", height, "px;",
            "min-height: ", height, "px;",
            "max-height: ", height, "px;"].join("");
  },
  _adjustWindowSize: function(width, height) {
    debug("adjustWindowSize:", width, height);
    let fixedSizeStyle = this._fixSizeInStyle(width, height);
    this._shellElement.setAttribute("style", "overflow: hidden; border: none;" +
                              fixedSizeStyle);
    this._homescreenElement.setAttribute("style", "-moz-box-flex: 1; overflow: hidden;" +
                                   "border: none;"+fixedSizeStyle);
  },
  _initObservers: function() {
    Services.obs.addObserver((function (message){
      debug("received 'simulator-adjust-window-size'.");
      this._adjustWindowSize(GlobalSimulatorScreen.width,
                             GlobalSimulatorScreen.height);
    }).bind(this), "simulator-adjust-window-size", false);

    // handling rotate button enabling/disabling
    Services.obs.addObserver((function (message){
      debug("received 'simulator-orientation-lock-change'.");
      if (GlobalSimulatorScreen.mozOrientationLocked) {
        this._rotateButtonElement.classList.remove("active");
      } else {
        this._rotateButtonElement.classList.add("active");
      }
    }).bind(this), "simulator-orientation-lock-change", false);
  },
  _injectStylesheet: function(win) {
    let winUtils = win.QueryInterface(Ci.nsIInterfaceRequestor).
                   getInterface(Ci.nsIDOMWindowUtils);
    winUtils.loadSheet(B2G_AGENTSHEET_URL, winUtils.AGENT_SHEET);
  },
  _initKeepWindowSize: function() {
    // WORKAROUND: keep the simulator window size
    let TOOLBOX_H = this._toolboxHeight;
    this._homescreen.addEventListener("resize", function() {
      debug("homescreen resize event received, resize window to fit.");
      let height = window.fullScreen ?
        GlobalSimulatorScreen.height : GlobalSimulatorScreen.height+TOOLBOX_H;
      window.resizeTo(GlobalSimulatorScreen.width, height);
    }, true);
  },
  _isValidOrientation: function (orientation) {
    return ["portrait", "portrait-primary", "portrait-secondary",
            "landscape", "landscape-primary", "landscape-secondary"].
      indexOf(orientation) > -1;
  },
  _getAppOrientation: function() {
    let appId = DOMApplicationRegistry._appId(appOrigin);
    let manifest = DOMApplicationRegistry._manifestCache[appId];

    if (manifest && manifest.orientation &&
        this._isValidOrientation(manifest.orientation)) {
      return manifest.orientation;
    }
  },
  _fixAppOrientation: function(appOrigin) {
    let orientation = this._getAppOrientation(appOrigin);
    if (orientation) {
      GlobalSimulatorScreen.mozOrientation = orientation;
        GlobalSimulatorScreen.adjustWindowSize();
    }

    // adjust simulator window size orientation
    // on app without manifests (website)
    this._adjustWindowSize(GlobalSimulatorScreen.width,
                           GlobalSimulatorScreen.height);
  },
  _applyB2GStylesheet: function(domEl) {
    if (domEl.appManifestURL === "app://homescreen.gaiamobile.org/manifest.webapp") {
      // NOTE: skip homescreen because as side-effects homescreen will not
      // be rendered correctly
      return;
    }
    debug("apply B2G stylesheet on contentWindow",
      domEl.contentDocument.nodePrincipal.origin);
    switchToB2GAgentSheet(domEl);
    this._monitorForNestedMozBrowsers(domEl);
  },
  _monitorForNestedMozBrowsers: function(domEl) {
    let doMonitor = (function () {
      debug("MONITOR for mozbrowsers", domEl.contentDocument.nodePrincipal.origin);
      if (this._mozBrowserObserver) {
        this._mozBrowserObserver.disconnect();
      }
      this._mozBrowserObserver = new MutationSummary({
        rootNode: domEl.contentDocument,
        queries: [{ element: 'iframe[mozbrowser]' }],
        callback: function(summaries) {
          debug("MONITORED mozbrowsers", JSON.stringify(summaries,null,2));
          if (summaries[0].added) {
            summaries[0].added.forEach(function(nestedEl) {
              debug("ELEMENT contentWindow", nestedEl.contentDocument.nodePrincipal.origin);
              switchToB2GAgentSheet(nestedEl);
            });
          }
        }
      });
    }).bind(this);

    domEl.addEventListener("unload", (function cb() {
      domEl.removeEventListener("unload", cb);
      domEl.removeEventListener("load", doMonitor);
      if (this._mozBrowserObserver) {
        this._mozBrowserObserver.disconnect();
        this._mozBrowserObserver = null;
      }
    }).bind(this), true);

    domEl.addEventListener("load", doMonitor, true);
  },
  // WORKAROUND: force setDisplayedApp
  _initMutationObservers: function() {
    let FIXDisplayedApp = {
      appOrigin: null,
      homescreenLoaded: false,
      appLoaded: false
    };

    let detectHomescreen = function detectHomescreen(iframe) {
      if (iframe.appManifestURL === "app://homescreen.gaiamobile.org/manifest.webapp") {
        navigator.mozSettings
          .createLock().set({'homescreen.ready': true});
        debug("HOMESCREEN READY");
        return true;
      }

      return false;
    };

    let detectApp = function detectApp(iframe, appOrigin) {
      debug("TRY TO DETECT APP:", appOrigin);
      if (iframe.appManifestURL === appOrigin+"/manifest.webapp") {
        return true;
      }

      return false;
    };

    let homescreen = this._homescreen;
    let fixAppOrientation = this._fixAppOrientation.bind(this);
    let applyB2GStylesheet = this._applyB2GStylesheet.bind(this);

    var appWindowObserver = new MutationSummary({
      rootNode: shell.contentBrowser.contentDocument,
      queries: [{ element: 'iframe[data-frame-origin]' }],
      callback: function(summaries) {
        debug("appWindowObserver", JSON.stringify(summaries, null, 2));
        let appOrigin = FIXDisplayedApp.appOrigin;
        summaries[0].added.forEach(function(iframe) {
          try {
            applyB2GStylesheet(iframe);

            if (detectHomescreen(iframe)) {
              FIXDisplayedApp.homescreenLoaded = true;
            }
            if (appOrigin && detectApp(iframe, appOrigin)) {
              FIXDisplayedApp.appLoaded = true;
            }
            if(FIXDisplayedApp.homescreenLoaded &&
               FIXDisplayedApp.appLoaded) {
              FIXDisplayedApp.appOrigin = null;
              FIXDisplayedApp.appLoaded = false;
              fixAppOrientation(appOrigin);
              homescreen.WindowManager.setDisplayedApp(appOrigin);
            }
          } catch(e) {
            Cu.reportError(e);
          }
        });
      }
    });

    Services.obs.addObserver(function (message){
      let appOrigin = message.wrappedJSObject.appOrigin;
      debug("received 'simulator-set-displayed-app':", appOrigin);
      FIXDisplayedApp.appOrigin = appOrigin;
    }, "simulator-set-displayed-app", false);
  }
};

debug("init window_manager tweaks.");
try {
  SimulatorWindowManager.init();
} catch(e) {
  Cu.reportError(e);
}
