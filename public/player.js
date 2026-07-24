// Web Audio engine: two music decks for crossfading, plus a voice channel
// that ducks the music so the AI DJ can talk over it.
//
// Graph:  deckGain[0] ┐
//         deckGain[1] ┼─▶ musicBus (duck) ─▶ master (volume) ─▶ destination
//         voiceGain  ─┘
export class RadioPlayer {
  constructor({ duckVolume = 0.22, crossfadeSeconds = 4 } = {}) {
    this.duckVolume = duckVolume;
    this.crossfadeSeconds = crossfadeSeconds;
    this.ctx = null;
    this.decks = [];
    this.active = 0;
    this.ready = false;
    this.onEnded = null; // called when the active track finishes naturally
    this.onTime = null; // (currentTime, duration) on each tick
  }

  // Must be called from a user gesture (autoplay policy).
  async init() {
    if (this.ready) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 1;
    this.musicBus.connect(this.master);

    this.voiceGain = this.ctx.createGain();
    this.voiceGain.gain.value = 1;
    this.voiceGain.connect(this.master);

    for (let i = 0; i < 2; i++) {
      const el = new Audio();
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      const src = this.ctx.createMediaElementSource(el);
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain);
      gain.connect(this.musicBus);
      el.addEventListener('ended', () => { if (i === this.active && this.onEnded) this.onEnded(); });
      el.addEventListener('timeupdate', () => {
        if (i === this.active && this.onTime) this.onTime(el.currentTime, el.duration || 0);
      });
      this.decks.push({ el, gain });
    }

    // Browsers suspend the AudioContext when the tab is backgrounded; resume on return.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.resume(); });
    this.ready = true;
  }

  async resume() { if (this.ctx?.state === 'suspended') await this.ctx.resume(); }

  get activeEl() { return this.decks[this.active].el; }
  get currentTime() { return this.activeEl?.currentTime || 0; }
  get duration() { return this.activeEl?.duration || 0; }
  get paused() { return this.activeEl?.paused ?? true; }

  setVolume(v) { if (this.master) this.master.gain.value = v; }

  // Crossfade into a new track on the idle deck.
  async playTrack(url) {
    await this.resume();
    const now = this.ctx.currentTime;
    const fade = Math.max(0.01, this.crossfadeSeconds);
    const next = 1 - this.active;
    const cur = this.decks[this.active];
    const nd = this.decks[next];

    nd.el.src = url;
    try { nd.el.currentTime = 0; } catch { /* not seekable yet */ }
    try { await nd.el.play(); } catch (e) { /* will retry on gesture */ }

    nd.gain.gain.cancelScheduledValues(now);
    nd.gain.gain.setValueAtTime(0.0001, now);
    nd.gain.gain.linearRampToValueAtTime(1, now + fade);

    cur.gain.gain.cancelScheduledValues(now);
    cur.gain.gain.setValueAtTime(cur.gain.gain.value, now);
    cur.gain.gain.linearRampToValueAtTime(0, now + fade);
    setTimeout(() => { try { cur.el.pause(); } catch {} }, fade * 1000 + 60);

    this.active = next;
  }

  pause() { try { this.activeEl.pause(); } catch {} }
  async play() { await this.resume(); try { await this.activeEl.play(); } catch {} }

  duck() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, now);
    this.musicBus.gain.linearRampToValueAtTime(this.duckVolume, now + 0.6);
  }

  unduck() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, now);
    this.musicBus.gain.linearRampToValueAtTime(1, now + 1.2);
  }

  // Fetch + decode a TTS clip and play it over the music (ducking).
  async playVoice(url) {
    await this.resume();
    let audioBuf;
    try {
      const arr = await fetch(url).then((r) => r.arrayBuffer());
      audioBuf = await this.ctx.decodeAudioData(arr);
    } catch (e) {
      return; // couldn't load/decode — skip the talk, keep the music going
    }
    this.duck();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; this.unduck(); resolve(); };
      try {
        const node = this.ctx.createBufferSource();
        node.buffer = audioBuf;
        node.connect(this.voiceGain);
        node.onended = finish;
        node.start();
      } catch (e) {
        finish();
        return;
      }
      // Safety net: never hang the show if 'onended' doesn't fire
      // (e.g. the tab was backgrounded and the context suspended mid-clip).
      setTimeout(finish, Math.ceil((audioBuf.duration + 5) * 1000));
    });
  }
}
