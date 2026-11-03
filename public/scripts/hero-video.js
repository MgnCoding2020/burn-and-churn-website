// Hero loop controls (WCAG 2.2.2 Pause, Stop, Hide). Served as an external
// file so the CSP (script-src 'self') holds. The loop stays invisible (CSS)
// until this script reveals it, so without JavaScript visitors see only the
// poster. The loop only downloads where its <source> media query matches.

const video = document.querySelector('.hero__video');
const toggle = document.querySelector('.hero__toggle');

if (video instanceof HTMLVideoElement && toggle instanceof HTMLButtonElement) {
  const sync = () => {
    const paused = video.paused;
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.textContent = paused ? 'Play animation' : 'Pause animation';
  };

  // Fade the loop in and show the control only once it's really playing.
  const reveal = () => {
    video.classList.add('is-playing');
    toggle.hidden = false;
    sync();
  };

  video.addEventListener('playing', reveal);
  video.addEventListener('pause', sync);

  toggle.addEventListener('click', () => {
    if (video.paused) video.play();
    else video.pause();
  });

  // Save-Data: don't start the loop for visitors asking to save bandwidth.
  if (navigator.connection && navigator.connection.saveData) video.pause();
  // The loop may have started before this script ran.
  else if (!video.paused && video.readyState >= 3) reveal();
}
