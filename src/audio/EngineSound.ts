/**
 * Audio sintetizzato con la Web Audio API (D16): nessun file audio.
 *
 *  - Motore: onda con le armoniche di un motore vero (base = metà della frequenza di scoppio,
 *    giri/min ÷ 60 × cilindri ÷ 2), due copie scordate, filtro che si apre col gas, acuti attenuati.
 *  - Gomme: rumore filtrato che sale quando le gomme sono oltre il limite.
 *  - Vento: rumore cupo che cresce con la velocità.
 *
 * I browser permettono l'audio solo dopo un'interazione dell'utente:
 * per questo `start()` viene chiamato dal pulsante "Entra in pista".
 */

export class EngineSound {
  /** Cilindri: 8 per la GT, 6 per la monoposto (V6 turbo ibrido) */
  cylinders = 8;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private oscs: OscillatorNode[] = [];
  private engineFilter!: BiquadFilterNode;
  private engineGain!: GainNode;
  private squealGain!: GainNode;
  private squealFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private loadFilter!: BiquadFilterNode;
  private loadGain!: GainNode;
  /** piccola variazione lenta dei giri, per un suono meno "sintetico" */
  private wobble = 0;
  /** Regime massimo dell'auto: agli alti giri il volume cala un po' (gli acuti stancano) */
  maxRpm = 8000;
  private muted = false;
  volume = 0.5;

  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    // ---- Motore ----
    // Timbro: un'onda "su misura" con le armoniche di un motore vero (ordine di scoppio forte,
    // mezzi ordini più deboli, acuti che calano in fretta) al posto di dente di sega + onda quadra,
    // che a lungo andare "ronzano". Due copie leggermente scordate danno corpo e un battimento
    // naturale; un filtro senza risonanza e un taglio degli acuti evitano il fischio ai giri alti.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 0.7;
    const tame = ctx.createBiquadFilter();
    tame.type = 'highshelf';
    tame.frequency.value = 2200;
    tame.gain.value = -9;
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 180;
    body.Q.value = 0.8;
    body.gain.value = 4;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(1.4);
    const mix = ctx.createGain();
    mix.gain.value = 0.7;
    mix.connect(shaper).connect(this.engineFilter).connect(body).connect(tame).connect(this.engineGain).connect(this.master);
    // armoniche della metà della frequenza di scoppio: le pari sono gli ordini di scoppio
    const amps = [0, 0.35, 1.0, 0.28, 0.5, 0.14, 0.26, 0.07, 0.13, 0.04, 0.06, 0.02, 0.035];
    const real = new Float32Array(amps.length);
    const imag = Float32Array.from(amps);
    const wave = ctx.createPeriodicWave(real, imag);
    for (const [detune, gain] of [[-6, 0.5], [7, 0.42]] as const) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(mix);
      (o as OscillatorNode & { mult: number }).mult = 0.5;
      o.start();
      this.oscs.push(o);
    }
    // con il gas: un po' di "graffio" (rumore filtrato attorno all'ordine di scoppio)
    this.loadFilter = ctx.createBiquadFilter();
    this.loadFilter.type = 'bandpass';
    this.loadFilter.Q.value = 1.2;
    this.loadGain = ctx.createGain();
    this.loadGain.gain.value = 0;
    this.loadFilter.connect(this.loadGain).connect(this.engineFilter);

    // ---- Rumore bianco condiviso (gomme e vento) ----
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise.buffer = buf;
    noise.loop = true;
    noise.start();
    noise.connect(this.loadFilter);

    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1100;
    this.squealFilter.Q.value = 3.5;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    noise.connect(this.squealFilter).connect(this.squealGain).connect(this.master);

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise.connect(windFilter).connect(this.windGain).connect(this.master);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx && !this.muted) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Mette in pausa/riprende l'audio (es. menu di pausa). */
  setPaused(p: boolean): void {
    if (!this.ctx) return;
    if (p) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  /**
   * @param rpm giri motore
   * @param throttle 0..1
   * @param maxSlip slip combinato massimo tra le gomme (1 = al limite)
   * @param speed m/s
   */
  update(rpm: number, throttle: number, maxSlip: number, speed: number, limiter: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const fireHz = (rpm / 60) * (this.cylinders / 2);
    this.wobble += (Math.random() - 0.5) * 0.002 - this.wobble * 0.05;
    const f = fireHz * (1 + this.wobble);
    for (const o of this.oscs) {
      o.frequency.setTargetAtTime(f * (o as OscillatorNode & { mult: number }).mult, t, 0.02);
    }
    const rpmN = Math.min(1, rpm / this.maxRpm);
    this.engineFilter.frequency.setTargetAtTime(Math.min(4500, 300 + f * (1.6 + 2.2 * throttle)), t, 0.04);
    this.loadFilter.frequency.setTargetAtTime(f * 2, t, 0.04);
    this.loadGain.gain.setTargetAtTime(0.05 + throttle * 0.12, t, 0.05);
    // Al limitatore il volume "balbetta"
    const stutter = limiter && Math.random() < 0.5 ? 0.55 : 1;
    this.engineGain.gain.setTargetAtTime((0.12 + throttle * 0.2) * (1 - 0.35 * rpmN) * stutter, t, 0.04);

    const squeal = Math.max(0, Math.min(1, (maxSlip - 0.85) * 1.6)) * Math.min(1, speed / 8);
    this.squealGain.gain.setTargetAtTime(squeal * 0.11, t, 0.08);
    this.squealFilter.frequency.setTargetAtTime(900 + maxSlip * 250, t, 0.05);

    this.windGain.gain.setTargetAtTime(Math.min(0.25, (speed / 90) ** 2 * 0.25), t, 0.1);
  }
}

function softClipCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}
