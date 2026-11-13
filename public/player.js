// <loopwell-player>: a Loopwell beat on any web page.
//
//   <script src="https://…/player.js" async></script>
//   <loopwell-player beat="…"></loopwell-player>
//
// `beat` is a share link or just the part after "#b=". Optional: theme
// (cream, night, slate, arcade, contrast; left out, it follows the visitor's
// light or dark setting) and pattern (which pattern to play when the beat has
// no song). The element has play(), pause() and toggle(), and fires a
// "loopwell-state" event with { state, time, duration } as it plays.
(() => {
  if (customElements.get('loopwell-player')) return;
  const home = new URL('.', (document.currentScript && document.currentScript.src) || location.href).href;

  class LoopwellPlayer extends HTMLElement {
    static get observedAttributes() { return ['beat', 'theme', 'pattern']; }

    constructor() {
      super();
      const shadow = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ':host{display:block;width:100%;max-width:560px;height:152px}iframe{display:block;width:100%;height:100%;border:0;border-radius:14px}';
      this.frame = document.createElement('iframe');
      this.frame.loading = 'lazy';
      this.frame.allow = 'autoplay';
      this.frame.title = 'A beat on Loopwell';
      shadow.append(style, this.frame);
      this.onMessage = (e) => {
        if (e.source !== this.frame.contentWindow || !e.data || e.data.loopwell !== 'state') return;
        this.dispatchEvent(new CustomEvent('loopwell-state', { detail: { state: e.data.state, time: e.data.time, duration: e.data.duration } }));
      };
    }

    connectedCallback() { addEventListener('message', this.onMessage); this.update(); }
    disconnectedCallback() { removeEventListener('message', this.onMessage); }
    attributeChangedCallback() { if (this.isConnected) this.update(); }

    update() {
      const beat = this.getAttribute('beat') || '';
      const found = /[#&]b=([^&]+)/.exec(beat);
      const code = (found ? found[1] : beat).replace(/[^A-Za-z0-9_-]/g, '');
      const theme = (this.getAttribute('theme') || '').replace(/[^a-z]/g, '');
      const pattern = parseInt(this.getAttribute('pattern') || '', 10);
      const src = home + 'embed.html#b=' + code + (theme ? '&theme=' + theme : '') + (pattern > 0 ? '&p=' + pattern : '');
      if (this.frame.src === src) return;
      // a change after the # alone doesn't reload a frame, so it is given a fresh one
      if (this.frame.src) {
        const next = this.frame.cloneNode();
        this.frame.replaceWith(next);
        this.frame = next;
      }
      this.frame.src = src;
    }

    send(what) { if (this.frame.contentWindow) this.frame.contentWindow.postMessage({ loopwell: what }, '*'); }
    play() { this.send('play'); }
    pause() { this.send('pause'); }
    toggle() { this.send('toggle'); }
  }

  customElements.define('loopwell-player', LoopwellPlayer);
})();
