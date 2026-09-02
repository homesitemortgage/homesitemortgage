/**
 * Hide the sticky call bar while the page's own hero buttons are on screen.
 *
 * On a 375x812 phone the bar is fixed at the bottom, and while the cookie banner
 * is up it is lifted to bottom:33vh — which lands it at y=466, directly on top of
 * the hero. Measured, it covered the last 18px of the opening paragraph on FHA and
 * 111px of it on DSCR, plus the hero's own "Start My Free Prequal" and "Call Us"
 * buttons entirely.
 *
 * Hiding it costs the visitor nothing here: the bar offers "Call Us" and "Get
 * Prequalified", and the hero buttons underneath are the same two actions with the
 * same destinations, including the same ?type= program parameter. The bar returns
 * as soon as the hero scrolls out of view, which is the point at which it starts
 * doing its job.
 *
 * The class is only styled inside a max-width:600px media query, so applying it on
 * a desktop viewport is a no-op.
 */
(function () {
  var bar = document.querySelector('.sticky-cta');
  var hero = document.querySelector('.page-hero-actions');
  if (!bar || !hero || !('IntersectionObserver' in window)) return;

  // Held in a variable rather than left as the temporary from
  // `new IntersectionObserver(...).observe(x)`: an observer whose only reference
  // is its target's internal state is not something to rely on across engines
  // when a call to action depends on it.
  var observer = new IntersectionObserver(function (entries) {
    bar.classList.toggle('is-behind-hero', entries[0].isIntersecting);
  }, { threshold: 0 });
  observer.observe(hero);
})();
