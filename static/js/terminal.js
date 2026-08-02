(function () {
  var pages = [];
  fetch(window.SITE_INDEX_URL || "/index.json")
    .then(function (r) { return r.json(); })
    .then(function (data) { pages = data; })
    .catch(function () {});

  function navLinks() {
    var map = {};
    document.querySelectorAll(".prompt-nav a").forEach(function (a) {
      map[a.textContent.trim().toLowerCase()] = a.getAttribute("href");
    });
    return map;
  }

  function slug(url) {
    return (url || "").replace(/^\/+|\/+$/g, "").split("/").pop() || "";
  }

  function findPage(name) {
    name = (name || "").toLowerCase();
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].kind === "page" && slug(pages[i].url) === name) return pages[i];
    }
    return null;
  }

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else window.location.href = "/";
  }

  function isSectionHref(href) {
    var target = slug(href);
    return pages.some(function (p) { return p.kind === "section" && slug(p.url) === target; });
  }

  function resolveSectionHref(name) {
    name = (name || "").toLowerCase();
    var nav = navLinks();
    if (nav[name]) return nav[name];
    var sectionPage = pages.find(function (p) { return p.kind === "section" && p.section === name; });
    return sectionPage ? sectionPage.url : null;
  }

  function currentSection() {
    var current = pages.find(function (p) { return p.url === window.location.pathname; });
    return current ? current.section : "";
  }

  function topLevelListing() {
    var nav = navLinks();
    return Object.keys(nav).map(function (label) {
      return label + (isSectionHref(nav[label]) ? "/" : "");
    }).join("  ");
  }

  function buildTree() {
    var nav = navLinks();
    var labels = Object.keys(nav);
    var lines = ["~"];
    labels.forEach(function (label, i) {
      var href = nav[label];
      var isLastTop = i === labels.length - 1;
      var branch = isLastTop ? "└── " : "├── ";
      if (!isSectionHref(href)) {
        lines.push(branch + label);
        return;
      }
      lines.push(branch + label + "/");
      var section = slug(href);
      var children = pages.filter(function (p) { return p.kind === "page" && p.section === section; });
      var prefix = isLastTop ? "    " : "│   ";
      children.forEach(function (p, j) {
        var isLastChild = j === children.length - 1;
        lines.push(prefix + (isLastChild ? "└── " : "├── ") + slug(p.url));
      });
    });
    return lines;
  }

  function completions(prefix) {
    if (!prefix) return [];
    prefix = prefix.toLowerCase();
    var words = ["help", "clear", "ls", "cd", "cat", "pwd", "tree"].concat(Object.keys(navLinks()));
    pages.forEach(function (p) { if (p.kind === "page") words.push(slug(p.url)); });
    var seen = {};
    var uniq = [];
    words.forEach(function (w) { if (!seen[w]) { seen[w] = true; uniq.push(w); } });
    return uniq.filter(function (w) { return w.indexOf(prefix) === 0; }).sort();
  }

  var isFinePointer = window.matchMedia && window.matchMedia("(pointer: fine)").matches;

  // ---- mode toggle -------------------------------------------------

  function applyMode(next) {
    document.documentElement.dataset.mode = next;
    localStorage.setItem("termMode", next);
    if (next === "default" && isFinePointer && bashInputEl) {
      bashInputEl.focus({ preventScroll: true });
    }
  }

  document.querySelectorAll("[data-mode-btn]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      applyMode(btn.getAttribute("data-mode-btn"));
    });
  });

  // ---- shared scroll keys -------------------------------------------

  var lastKey = "";
  var lastKeyTime = 0;

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var active = document.activeElement;
    var inTextField = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
    // Our own command inputs don't block single-key shortcuts while still empty —
    // none of our commands start with j/k/g/G/q, so this is unambiguous.
    var isOwnEmptyInput = (active === bashInputEl || active === vimInputEl) && active.value === "";
    var typing = inTextField && !isOwnEmptyInput;

    handleVimKeydown(e, typing);
    if (e.defaultPrevented) return;
    if (typing) return;

    if (e.key !== "g") lastKey = "";

    switch (e.key) {
      case "j":
      case "ArrowDown":
        window.scrollBy({ top: 60, behavior: "smooth" });
        break;
      case "k":
      case "ArrowUp":
        window.scrollBy({ top: -60, behavior: "smooth" });
        break;
      case "G":
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        break;
      case "g":
        if (lastKey === "g" && Date.now() - lastKeyTime < 500) {
          window.scrollTo({ top: 0, behavior: "smooth" });
          lastKey = "";
        } else {
          lastKey = "g";
          lastKeyTime = Date.now();
        }
        break;
      case "q":
        goBack();
        return;
      default:
        return;
    }
    if (inTextField) e.preventDefault();
  });

  // ---- vim mode -------------------------------------------------

  var vimModeEl = document.getElementById("vim-mode");
  var vimMessageEl = document.getElementById("vim-message");
  var vimInputEl = document.getElementById("vim-input");
  var vimState = "normal";
  var vimTab = { prefix: null, matches: [], index: -1 };

  function vimMessage(text) {
    if (vimMessageEl) vimMessageEl.textContent = text || "";
  }

  function setVimState(next) {
    vimState = next;
    if (!vimModeEl || !vimInputEl || !vimMessageEl) return;
    if (vimState === "command") {
      vimModeEl.textContent = "-- COMMAND --";
      vimModeEl.className = "mode-command";
      vimInputEl.classList.add("active");
      vimMessageEl.style.display = "none";
    } else {
      vimModeEl.textContent = "-- NORMAL --";
      vimModeEl.className = "";
      vimInputEl.classList.remove("active");
      vimInputEl.blur();
      vimMessageEl.style.display = "";
    }
  }

  function runVimCommand(raw) {
    var text = raw.replace(/^:/, "").trim();
    if (!text) return;
    var parts = text.split(/\s+/);
    var cmd = parts[0];
    var arg = parts[1];
    var nav = navLinks();

    switch (cmd) {
      case "e":
      case "b": {
        if (!arg) { vimMessage("E32: No file name"); break; }
        var href = nav[arg.toLowerCase()];
        if (href) { window.location.href = href; return; }
        var page = findPage(arg);
        if (page) { window.location.href = page.url; return; }
        vimMessage('E345: Can\'t find file "' + arg + '" in path');
        break;
      }
      case "ls": {
        if (!arg) {
          vimMessage(Object.keys(nav).map(function (n) { return '"' + n + '"'; }).join("  "));
          break;
        }
        var sectionHref = nav[arg.toLowerCase()];
        if (!sectionHref) { vimMessage('E345: Can\'t find file "' + arg + '" in path'); break; }
        var section = slug(sectionHref);
        var children = pages.filter(function (p) { return p.kind === "page" && p.section === section; });
        if (!children.length) { vimMessage(arg + ": empty"); break; }
        vimMessage(children.map(function (p) { return '"' + slug(p.url) + '"'; }).join("  "));
        break;
      }
      case "q":
        goBack();
        return;
      case "h":
      case "help":
        vimMessage("normal: j/k scroll, gg/G top/bottom, q quit, : command  |  command: :e <page>, :ls [section], :q, :h");
        break;
      default:
        vimMessage("E492: Not an editor command: " + cmd);
    }
  }

  function vimTabComplete() {
    var val = vimInputEl.value.replace(/^:/, "");
    var spaceIdx = val.lastIndexOf(" ");
    var prefix = spaceIdx === -1 ? val : val.slice(spaceIdx + 1);
    if (vimTab.prefix !== prefix) {
      vimTab.prefix = prefix;
      vimTab.matches = completions(prefix);
      vimTab.index = -1;
    }
    if (!vimTab.matches.length) return;
    vimTab.index = (vimTab.index + 1) % vimTab.matches.length;
    var head = spaceIdx === -1 ? "" : val.slice(0, spaceIdx + 1);
    vimInputEl.value = ":" + head + vimTab.matches[vimTab.index];
  }

  function handleVimKeydown(e, typing) {
    if (!vimInputEl || document.documentElement.dataset.mode !== "vim") return;

    if (vimState === "command") {
      if (!typing) return;
      if (e.key === "Enter") {
        var val = vimInputEl.value;
        vimInputEl.value = "";
        setVimState("normal");
        runVimCommand(val);
        e.preventDefault();
      } else if (e.key === "Escape") {
        vimInputEl.value = "";
        setVimState("normal");
        e.preventDefault();
      } else if (e.key === "Tab") {
        e.preventDefault();
        vimTabComplete();
      } else {
        vimTab.prefix = null;
      }
      return;
    }

    if (typing) return;

    if (e.key === ":") {
      e.preventDefault();
      setVimState("command");
      vimInputEl.value = ":";
      vimInputEl.focus({ preventScroll: true });
    }
  }

  // ---- default (bash) mode -------------------------------------------------

  var bashOutputEl = document.getElementById("term-cli-output");
  var bashInputEl = document.getElementById("term-cli-input");
  var bashTypeboxEl = document.getElementById("term-cli-typebox");
  var bashCursorEl = document.getElementById("term-cli-cursor");
  var bashTab = { prefix: null, matches: [], index: -1 };

  var measureCtx = document.createElement("canvas").getContext("2d");

  function updateBashCursor() {
    if (!bashInputEl || !bashCursorEl) return;
    var cs = getComputedStyle(bashInputEl);
    measureCtx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    var pos = bashInputEl.selectionStart == null ? bashInputEl.value.length : bashInputEl.selectionStart;
    var width = measureCtx.measureText(bashInputEl.value.substring(0, pos)).width;
    bashCursorEl.style.transform = "translateX(" + width + "px)";
  }

  function bashPrintln(text, cls) {
    if (!bashOutputEl) return;
    var line = document.createElement("div");
    line.className = "cli-out-line" + (cls ? " " + cls : "");
    line.textContent = text;
    bashOutputEl.appendChild(line);
    bashOutputEl.scrollTop = bashOutputEl.scrollHeight;
  }

  function runBashCommand(cmdline) {
    var parts = cmdline.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    var cmd = parts[0].toLowerCase();
    var arg = parts[1];

    switch (cmd) {
      case "help":
        bashPrintln("commands:  ls [dir]   cd [dir|..|~|home]   cat <file>   pwd   tree   clear   help  (Tab completes, gg/G/j/k scroll)");
        bashPrintln("home:  " + topLevelListing());
        break;

      case "pwd":
        bashPrintln(window.location.pathname);
        break;

      case "tree":
        buildTree().forEach(function (line) { bashPrintln(line); });
        break;

      case "clear":
        bashOutputEl.innerHTML = "";
        var mainEl = document.querySelector(".term-body main");
        if (mainEl) mainEl.innerHTML = "";
        break;

      case "ls": {
        if (!arg) {
          var cwd = currentSection();
          if (!cwd) { bashPrintln(topLevelListing()); break; }
          var here = pages.filter(function (p) { return p.kind === "page" && p.section === cwd; });
          if (!here.length) { bashPrintln("(empty)"); break; }
          here.forEach(function (p) { bashPrintln(slug(p.url) + "  —  " + p.title); });
          break;
        }
        var href = resolveSectionHref(arg);
        if (!href) { bashPrintln("ls: " + arg + ": No such file or directory"); break; }
        var section = slug(href);
        var children = pages.filter(function (p) { return p.kind === "page" && p.section === section; });
        if (!children.length) { bashPrintln("ls: " + arg + ": Not a directory"); break; }
        children.forEach(function (p) { bashPrintln(slug(p.url) + "  —  " + p.title); });
        break;
      }

      case "cd": {
        if (!arg || arg === "~" || arg === "home") { window.location.href = "/"; break; }
        if (arg === "..") {
          var current = pages.find(function (p) { return p.url === window.location.pathname; });
          if (current && current.kind === "page" && current.section) {
            var sectionPage = pages.find(function (p) { return p.kind === "section" && p.section === current.section; });
            window.location.href = sectionPage ? sectionPage.url : "/";
          } else {
            window.location.href = "/";
          }
          break;
        }
        var cdHref = resolveSectionHref(arg);
        if (!cdHref) { bashPrintln("cd: " + arg + ": No such file or directory"); break; }
        if (!isSectionHref(cdHref)) { bashPrintln("cd: " + arg + ": Not a directory"); break; }
        window.location.href = cdHref;
        break;
      }

      case "cat": {
        if (!arg) { bashPrintln("usage: cat <page>"); break; }
        var navHref = resolveSectionHref(arg);
        if (navHref) {
          if (isSectionHref(navHref)) { bashPrintln("cat: " + arg + ": Is a directory"); break; }
          window.location.href = navHref;
          break;
        }
        var page = findPage(arg);
        if (page) { window.location.href = page.url; break; }
        bashPrintln("cat: " + arg + ": No such file or directory");
        break;
      }

      default:
        bashPrintln("bash: " + cmd + ": command not found");
    }
  }

  function bashTabComplete() {
    var val = bashInputEl.value;
    var spaceIdx = val.lastIndexOf(" ");
    var prefix = spaceIdx === -1 ? val : val.slice(spaceIdx + 1);
    if (bashTab.prefix !== prefix) {
      bashTab.prefix = prefix;
      bashTab.matches = completions(prefix);
      bashTab.index = -1;
    }
    if (!bashTab.matches.length) return;
    bashTab.index = (bashTab.index + 1) % bashTab.matches.length;
    var head = spaceIdx === -1 ? "" : val.slice(0, spaceIdx + 1);
    bashInputEl.value = head + bashTab.matches[bashTab.index];
    updateBashCursor();
  }

  if (bashInputEl) {
    var bashHistory = [];
    var bashHistoryIndex = 0;

    bashInputEl.addEventListener("focus", function () {
      if (bashTypeboxEl) bashTypeboxEl.classList.add("focused");
      updateBashCursor();
    });
    bashInputEl.addEventListener("blur", function () {
      if (bashTypeboxEl) bashTypeboxEl.classList.remove("focused");
    });
    bashInputEl.addEventListener("input", updateBashCursor);
    bashInputEl.addEventListener("click", updateBashCursor);
    bashInputEl.addEventListener("keyup", function (e) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") updateBashCursor();
    });

    bashInputEl.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") bashTab.prefix = null;

      if (e.key === "Enter") {
        var val = bashInputEl.value;
        bashPrintln("$ " + val, "cli-echo");
        if (val.trim()) bashHistory.push(val);
        bashHistoryIndex = bashHistory.length;
        runBashCommand(val);
        bashInputEl.value = "";
        updateBashCursor();
      } else if (e.key === "ArrowUp" && document.documentElement.dataset.mode === "default") {
        if (bashHistoryIndex > 0) {
          bashHistoryIndex--;
          bashInputEl.value = bashHistory[bashHistoryIndex] || "";
          updateBashCursor();
        }
        e.preventDefault();
      } else if (e.key === "ArrowDown" && document.documentElement.dataset.mode === "default") {
        if (bashHistoryIndex < bashHistory.length) {
          bashHistoryIndex++;
          bashInputEl.value = bashHistory[bashHistoryIndex] || "";
          updateBashCursor();
        }
        e.preventDefault();
      } else if (e.key === "Tab") {
        e.preventDefault();
        bashTabComplete();
      }
    });
  }

  // ---- initial focus -------------------------------------------------

  if (document.documentElement.dataset.mode === "default" && isFinePointer && bashInputEl) {
    bashInputEl.focus({ preventScroll: true });
  }
})();
