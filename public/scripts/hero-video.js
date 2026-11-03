// Hero loop controls (WCAG 2.2.2 Pause, Stop, Hide). Served as an external
// file so the CSP (script-src 'self') holds. Without JavaScript the poster
// image still shows; the loop only plays where its <source> media matches.

const video = document.querySelector('.hero__video');
const toggle = document.querySelector('.hero__toggle');

if (video instanceof HTMLVideoElement && toggle instanceof HTMLButtonElement) {
  const sync = () => {
    const paused = video.paused;
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.textContent = paused ? 'Play animation' : 'Pause animation';
  };

  // Show the control only when the loop is really playing.
  video.addEventListener('playing', () => {
    toggle.hidden = false;
    sync();
  });
  video.addEventListener('pause', sync);

  toggle.addEventListener('click', () => {
    if (video.paused) video.play();
    else video.pause();
  });

  // Save-Data: don't start the loop for visitors asking to save bandwidth.
  if (navigator.connection && navigator.connection.saveData) video.pause();
}
