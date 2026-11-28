// Intro screen when the app opens: the animated G2CMI logo (src/styles/intro.css).
//
// index.html starts with an empty full-screen <div id="intro">, so the app
// never shows half-drawn underneath; this fills it with the logo, then fades
// it out after the animation (or straight away on a tap). If this code never
// runs, the CSS still removes the intro after a few seconds.
//
// Automated tests (navigator.webdriver) skip it so every test doesn't wait
// 2.5 s; a test can ask for it with localStorage 'linecard.intro' = 'show'.

import logoSvg from '../brand/logo-animated.svg?raw';

const PLAY_MS = 2500; // the animation is done by about 2.1 s
const QUICK_MS = 900; // Reduce Motion: just show the logo briefly
const FADE_MS = 350;

export function playIntro() {
  const box = document.getElementById('intro');
  if (!box) return;
  if (navigator.webdriver && readFlag() !== 'show') {
    box.remove();
    return;
  }
  const plate = document.createElement('div');
  plate.className = 'intro-plate';
  plate.innerHTML = logoSvg; // our own file, shipped with the app
  box.append(plate);

  let done = false;
  const leave = () => {
    if (done) return;
    done = true;
    box.classList.add('is-leaving');
    setTimeout(() => box.remove(), FADE_MS);
  };
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const timer = setTimeout(leave, reduce ? QUICK_MS : PLAY_MS);
  box.addEventListener('click', () => {
    clearTimeout(timer);
    leave();
  });
}

function readFlag() {
  try {
    return localStorage.getItem('linecard.intro');
  } catch {
    return null;
  }
}
