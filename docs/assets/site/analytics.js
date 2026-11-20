// Google Analytics 4, off by default.
// Leave the id empty and this file does nothing: no banner, no request, no cookie.
// Set it to a GA4 measurement id ("G-...") and visitors are asked first; gtag.js loads only after "Accept".
const GA_MEASUREMENT_ID = "G-6KMR96TM61";

(function () {
  if (!GA_MEASUREMENT_ID) return;
  var KEY = "consessus-analytics-consent";
  var read = function () { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  var write = function (v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) {} };

  function load() {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
    window.gtag("js", new Date());
    window.gtag("config", GA_MEASUREMENT_ID, { anonymize_ip: true, allow_google_signals: false, allow_ad_personalization_signals: false });
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_MEASUREMENT_ID);
    document.head.appendChild(s);
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest('a[href^="https://github.com/"]');
      if (a) window.gtag("event", "outbound_click", { link_url: a.href, transport_type: "beacon" });
    });
    document.addEventListener("consessus:copy", function (e) {
      if (e.detail && e.detail.install) window.gtag("event", "copy_install_command");
    });
  }

  function banner() {
    if (document.querySelector(".consent")) return;
    var box = document.createElement("div");
    box.className = "consent"; box.setAttribute("role", "region"); box.setAttribute("aria-label", "Analytics consent");
    box.innerHTML = "<p>May this site use Google Analytics to count page views, clicks to GitHub and copies of the install command? Nothing is loaded unless you accept.</p>" +
      '<div class="cta"><button type="button" class="btn primary" data-v="yes">Accept</button><button type="button" class="btn" data-v="no">Decline</button></div>';
    box.addEventListener("click", function (e) {
      var v = e.target.getAttribute("data-v");
      if (!v) return;
      write(v); box.remove();
      if (v === "yes") load();
    });
    document.body.appendChild(box);
    box.querySelector("button").focus({ preventScroll: true });
  }

  // The static footer line says nothing is collected; replace it now that analytics is configured.
  var note = document.getElementById("privacy-note");
  if (note) {
    note.textContent = "Privacy: if you accept, this site uses Google Analytics 4 to count page views, clicks on links to GitHub and copies of the install command, with IP anonymisation and advertising features off. If you decline, nothing is loaded. ";
    var change = document.createElement("button");
    change.type = "button"; change.className = "linkbtn"; change.textContent = "Change your choice";
    // Scripts that already loaded stay until the next page load, so reload after clearing an acceptance.
    change.addEventListener("click", function () { var had = read(); write(null); if (had === "yes") location.reload(); else banner(); });
    note.appendChild(change);
  }

  var choice = read();
  if (choice === "yes") load(); else if (choice !== "no") banner();
})();
