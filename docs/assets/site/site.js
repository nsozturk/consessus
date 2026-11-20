// Consessus site: copy buttons, the landing-page scenery, the hero stage, feature demos, the image lightbox, the mobile docs menu, docs search and the active sidebar link.
(function () {
  document.querySelectorAll("pre").forEach(function (pre) {
    var code = pre.querySelector("code");
    if (!code || !navigator.clipboard) return;
    var b = document.createElement("button");
    b.className = "copy"; b.type = "button"; b.textContent = "Copy";
    b.addEventListener("click", function () {
      // data-copy holds the commands alone when the block also shows output.
      var text = pre.getAttribute("data-copy") || code.innerText;
      navigator.clipboard.writeText(text).then(function () {
        b.textContent = "Copied";
        setTimeout(function () { b.textContent = "Copy"; }, 1200);
        document.dispatchEvent(new CustomEvent("consessus:copy", { detail: { install: pre.hasAttribute("data-install") } }));
      }, function () {});
    });
    pre.insertBefore(b, pre.firstChild);
  });

  // Landing page: the fixed background shows the scene of the section that crosses the middle of the viewport.
  var scenery = document.querySelector(".scenery");
  if (scenery && "IntersectionObserver" in window) {
    var layers = scenery.querySelectorAll("i"), marks = [].slice.call(document.querySelectorAll("[data-scene]"));
    // Same breakpoint as the CSS background and the preload links.
    var suffix = matchMedia("(max-width: 960px)").matches ? "-960.webp" : ".webp";
    var file = function (n) { return "assets/site/scene-" + n + suffix; };
    var first = marks[0].getAttribute("data-scene"), shown = first, want = first, top = 0;
    var show = function (el) {
      var n = el.getAttribute("data-scene"), next = marks[marks.indexOf(el) + 1];
      want = n;
      if (next) new Image().src = file(next.getAttribute("data-scene")); // only the current and the next scene are fetched
      if (n === shown) return;
      var img = new Image();
      img.onload = function () {
        if (want !== n || shown === n) return; // the reader has scrolled on
        // ponytail: two layers; a third scene arriving mid-fade cuts in without a fade. Add a queue if that shows.
        top = 1 - top; shown = n;
        layers[top].style.backgroundImage = 'url("' + img.src + '")';
        layers[top].classList.toggle("drift", n === first);
        layers[top].classList.add("on");
        layers[1 - top].classList.remove("on");
      };
      img.src = file(n);
    };
    var sceneIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) show(en.target); });
    }, { rootMargin: "-50% 0px -50% 0px" });
    marks.forEach(function (m) { sceneIo.observe(m); });
    document.addEventListener("visibilitychange", function () { scenery.classList.toggle("paused", document.hidden); });
  }

  var anim = document.documentElement.classList.contains("anim"); // set in the page head unless reduced motion is asked for
  var el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text; // script text is data, never markup
    return e;
  };

  // Hero stage: draws assets/demo/hero-flow.json into the four windows and, when motion is allowed, plays it in a loop.
  // The page already holds the final state between the hero-flow:static markers, so this is an enhancement.
  var stage = document.querySelector(".stage[data-flow]");
  if (stage) {
    var wins = stage.querySelector(".wins"), hub = stage.querySelector(".hub"), say = stage.querySelector(".hub-say");
    var dot = stage.querySelector(".dot"), ctl = stage.querySelector(".stage-ctl"), box = {};
    var words = { command: "runs", incoming: "receives", working: "is working", answer: "answers", notice: "is told", result: "reads the answers" };
    var render = function (flow) {
      var logs = {}, names = {}, told = [], made = document.createDocumentFragment(); // swapped in only when all of it built
      flow.panes.forEach(function (p) {
        var w = el("div", "win w-" + p.app.toLowerCase().replace(/[^a-z]/g, "")), bar = el("div", "bar"), comp = el("div", "comp");
        w.setAttribute("data-pane", p.id);
        w.style.setProperty("--t", p.tint);
        bar.append(el("i"), el("b", "", p.app), el("span", "", p.role));
        comp.append(el("em", "", p.model || ""));
        w.append(bar, el("div", "rail"), logs[p.id] = el("div", "log"), comp);
        made.append(box[p.id] = w);
        names[p.id] = p.app + " (" + p.role + ")";
      });
      flow.steps.forEach(function (s) {
        if (!logs[s.at]) return;
        s.text = String(s.text == null ? "" : s.text);
        var cut = s.kind === "incoming" ? s.text.indexOf("\n") : -1;
        s.el = el("div", "m k-" + s.kind);
        if (cut > 0) s.el.append(el("div", "h", s.text.slice(0, cut)));
        s.el.append(s.body = el("div", "b", cut > 0 ? s.text.slice(cut + 1) : s.text));
        logs[s.at].append(s.el);
        if (s.kind !== "working") told.push(names[s.at] + " " + (words[s.kind] || s.kind) + ": " + s.text.replace(/\s+/g, " "));
      });
      wins.textContent = "";
      wins.append(made);
      stage.querySelector(".sr").textContent = "Four app windows in room " + flow.room + " exchange messages through Consessus. " + told.join(" ");
      var cap = stage.querySelector(".stage-cap"), link = el("a", "", "transcript");
      link.href = stage.getAttribute("data-flow");
      cap.textContent = flow.provisional ? "Illustration of a room assign flow" : "Recorded from one live room; the words are in the ";
      if (!flow.provisional) cap.append(link);
    };
    var play = function (flow) {
      var steps = flow.steps.filter(function (s) { return s.el; }), lead = flow.lead || flow.panes[0].id, run = 0;
      var hold = { user: false, hidden: document.hidden, away: false }; // three independent reasons to stand still
      var held = function () { return hold.user || hold.hidden || hold.away; };
      var sync = function () { stage.classList.toggle("paused", held()); };
      // Resolves after ms of unpaused time; rejects when a newer run has started.
      var sleep = function (ms, id) {
        return new Promise(function (ok, stop) {
          (function tick() {
            if (id !== run) return stop();
            if (!held() && (ms -= 50) < 0) return ok();
            setTimeout(tick, 50);
          })();
        });
      };
      var row = function () { return wins.scrollWidth > wins.clientWidth + 4; }; // phones: the windows are one swipe row
      var bring = function (w) { if (row()) wins.scrollTo({ left: w.offsetLeft - wins.offsetLeft - 8, behavior: "smooth" }); };
      var mid = function (node) {
        var r = node.getBoundingClientRect(), g = dot.parentNode.getBoundingClientRect();
        return "translate(" + (r.left + r.width / 2 - g.left) + "px," + (r.top + r.height / 2 - g.top) + "px)";
      };
      // One message: a light in the sender's tint goes sender -> Consessus node -> receiver.
      var pulse = async function (from, to, via, id) {
        var a = box[from], b = box[to];
        if (!a || !b) return;
        var tint = a.style.getPropertyValue("--t");
        hub.style.setProperty("--t", tint);
        dot.style.setProperty("--t", tint);
        if (!row() && dot.animate) {
          dot.animate([{ transform: mid(a), opacity: 0 }, { opacity: 1, offset: 0.12 }, { transform: mid(hub), opacity: 1, offset: 0.5 },
            { opacity: 1, offset: 0.88 }, { transform: mid(b), opacity: 0 }], { duration: 1000, easing: "ease-in-out" });
          await sleep(450, id);
        }
        if (via) say.textContent = via;
        hub.classList.add("hit");
        bring(b);
        await sleep(520, id);
        hub.classList.remove("hit");
        b.classList.remove("glow");
        void b.offsetWidth; // restart the glow when the same window is hit twice
        b.classList.add("glow");
      };
      var loop = async function () {
        var id = ++run;
        stage.querySelectorAll(".typing").forEach(function (t) { t.remove(); });
        steps.forEach(function (s) { s.el.classList.add("off"); s.body.textContent = s.body.full || s.body.textContent; });
        say.textContent = "";
        stage.classList.add("ready");
        try {
          await sleep(500, id);
          for (var i = 0; i < steps.length; i++) {
            var s = steps[i], log = s.el.parentNode;
            if (s.from && s.from !== s.at) await pulse(s.from, s.at, s.via, id);
            else if (s.kind !== "working") bring(box[s.at]);
            if (s.kind === "command") { // typed out
              var full = s.body.full = s.body.textContent, n = 0, per = Math.max(2, Math.ceil(full.length / 28));
              s.body.textContent = "";
              s.el.classList.remove("off");
              while (n < full.length) { s.body.textContent = full.slice(0, n += per); await sleep(50, id); }
            } else {
              if (s.kind !== "working") {
                var dots = log.appendChild(el("div", "typing"));
                await sleep(550, id);
                dots.remove();
              }
              s.el.classList.remove("off");
            }
            await sleep(s.kind === "working" ? 250 : 650, id);
            if (s.kind === "answer" && s.at !== lead) await pulse(s.at, lead, s.via, id);
          }
          await sleep(7000, id);
          loop();
        } catch (e) { if (e) throw e; } // a newer run took over
      };
      ctl.hidden = false;
      ctl.addEventListener("click", function (e) {
        var act = e.target.getAttribute("data-act"), pause = ctl.querySelector('[data-act="pause"]');
        if (!act) return;
        hold.user = act === "pause" && !hold.user;
        pause.textContent = hold.user ? "Play" : "Pause";
        sync();
        if (act === "replay") loop();
      });
      document.addEventListener("visibilitychange", function () { hold.hidden = document.hidden; sync(); });
      if ("IntersectionObserver" in window) new IntersectionObserver(function (entries) {
        hold.away = !entries[entries.length - 1].isIntersecting; sync();
      }).observe(stage);
      loop();
    };
    fetch(stage.getAttribute("data-flow")).then(function (r) { return r.json(); }).then(function (flow) {
      render(flow);
      if (anim) play(flow);
    }).catch(function () { stage.classList.add("still"); }); // the markup's final state stays
  }

  // Feature demos and section reveals: each plays once when it scrolls into view; a demo can be replayed.
  if (anim) {
    var seen = "IntersectionObserver" in window && new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add(en.target.hasAttribute("data-demo") ? "play" : "in");
        seen.unobserve(en.target);
      });
    }, { rootMargin: "0px 0px -8% 0px" }); // any part in view counts, so a pane taller than the screen still shows
    document.querySelectorAll(".band .pane, [data-demo]").forEach(function (node) {
      if (seen) seen.observe(node); else node.classList.add("in", "play");
      if (!node.hasAttribute("data-demo")) return;
      var again = node.appendChild(el("button", "replay", "Replay"));
      again.type = "button";
      again.addEventListener("click", function () { node.classList.remove("play"); void node.offsetWidth; node.classList.add("play"); });
    });
  }

  // Lightbox: every content image opens in a modal dialog (close button, click outside, Escape). Without JavaScript
  // the gallery links still open the image file.
  var content = document.querySelector("main");
  if (content && window.HTMLDialogElement) {
    var lb = el("dialog", "lb"), shut = el("button", "lb-x", "×"), fig = el("figure"), pic = el("img"), note = el("figcaption"), opener;
    lb.setAttribute("aria-label", "Image viewer");
    shut.type = "button"; shut.setAttribute("aria-label", "Close image");
    fig.append(pic, note); lb.append(shut, fig); document.body.append(lb);
    var zooms = function (img) { return img && !img.closest(".stage, [data-demo]") && img.getBoundingClientRect().width >= 96; }; // not icons
    var isImage = function (a) { return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(a.pathname); };
    var enlarge = function (img) {
      var a = img.closest("a[href]"), f = img.closest("figure"), cap = f && f.querySelector("figcaption"), from = img.getBoundingClientRect();
      opener = a || img;
      pic.src = a && isImage(a) ? a.href : img.currentSrc || img.src; // the full-size file when the link has one
      pic.alt = img.alt;
      note.textContent = cap ? cap.textContent : img.alt;
      lb.showModal();
      var grow = function () {
        var to = pic.getBoundingClientRect();
        if (to.width) pic.animate([{ transform: "translate(" + (from.left + from.width / 2 - to.left - to.width / 2) + "px," +
          (from.top + from.height / 2 - to.top - to.height / 2) + "px) scale(" + from.width / to.width + ")" }, { transform: "none" }],
          { duration: 260, easing: "ease-out" });
      };
      if (anim && pic.animate) { if (pic.complete) grow(); else pic.onload = grow; }
    };
    content.querySelectorAll("img").forEach(function (img) {
      if (img.closest("a") || !zooms(img)) return;
      img.tabIndex = 0; img.setAttribute("role", "button"); img.setAttribute("aria-haspopup", "dialog");
    });
    content.addEventListener("click", function (e) {
      var t = e.target, img = t.tagName === "IMG" ? t : t.tagName === "A" && t.querySelector("img"); // Enter on a link clicks the link
      var link = img && img.closest("a[href]");
      if (!zooms(img) || (link && !isImage(link)) || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // other links navigate
      e.preventDefault();
      enlarge(img);
    });
    content.addEventListener("keydown", function (e) {
      if ((e.key !== "Enter" && e.key !== " ") || e.target.tagName !== "IMG" || !zooms(e.target)) return;
      e.preventDefault();
      enlarge(e.target);
    });
    lb.addEventListener("click", function (e) { if (e.target === lb || e.target === shut) lb.close(); });
    lb.addEventListener("keydown", function (e) { if (e.key === "Tab") { e.preventDefault(); shut.focus(); } }); // the close button is the only stop
    lb.addEventListener("close", function () { pic.onload = null; if (opener) opener.focus(); });
  }

  var side = document.querySelector("nav.side"), menu = document.querySelector(".menu");
  if (!side) return;
  var setOpen = function (open) { side.classList.toggle("open", open); menu.setAttribute("aria-expanded", String(open)); };
  menu.addEventListener("click", function () { setOpen(!side.classList.contains("open")); });
  var sections = [].slice.call(document.querySelectorAll("main section"));
  var links = [].slice.call(side.querySelectorAll("a"));
  links.forEach(function (a) { a.addEventListener("click", function () { setOpen(false); }); });
  document.getElementById("search").addEventListener("input", function (e) {
    var q = e.target.value.trim().toLowerCase();
    sections.forEach(function (s) { s.classList.toggle("hidden", q !== "" && s.textContent.toLowerCase().indexOf(q) === -1); });
    links.forEach(function (a) {
      var target = document.querySelector(a.getAttribute("href"));
      var section = target && target.closest("section");
      a.parentNode.classList.toggle("hidden", !!section && section.classList.contains("hidden"));
    });
  });
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id); });
      });
    }, { rootMargin: "-40% 0px -55% 0px" });
    sections.forEach(function (s) { io.observe(s); });
  }
})();
