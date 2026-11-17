/**
 * Audio sintetizzato con la Web Audio API (D16): nessun file audio.
 *
 *  - Motore: oscillatori alla frequenza di scoppio (giri/min ÷ 60 × cilindri ÷ 2),
 *    distorsione leggera e filtro passa-basso che si apre con l'acceleratore.
 *  - Gomme: rumore filtrato che sale quando le gomme sono oltre il limite.
 *  - Vento: rumore cupo che cresce con la velocità.
 *
 * I browser permettono l'audio solo dopo un'interazione dell'utente:
 * per questo `start()` viene chiamato dal pulsante "Entra in pista".
 */

const CYLINDERS = 8;

export class EngineSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private oscs: OscillatorNode[] = [];
  private engineFilter!: BiquadFilterNode;
  private engineGain!: GainNode;
  private squealGain!: GainNode;
  private squealFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private muted = false;
  volume = 0.5;

  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // ---- Motore ----
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 2.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(2.2);
    const mix = ctx.createGain();
    mix.connect(shaper).connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    // fondamentale, sub-armonica e armonica: insieme danno un timbro "a scoppi"
    const defs: [OscillatorType, number, number][] = [
      ['sawtooth', 1, 0.5],
      ['square', 0.5, 0.35],
      ['sawtooth', 2, 0.18],
      ['triangle', 1.5, 0.12],
    ];
    for (const [type, mult, gain] of defs) {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(mix);
      (o as OscillatorNode & { mult: number }).mult = mult;
      o.start();
      this.oscs.push(o);
    }

    // ---- Rumore bianco condiviso (gomme e vento) ----
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise.buffer = buf;
    noise.loop = true;
    noise.start();

    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1100;
    this.squealFilter.Q.value = 6;
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
    const fireHz = (rpm / 60) * (CYLINDERS / 2);
    for (const o of this.oscs) {
      o.frequency.setTargetAtTime(fireHz * (o as OscillatorNode & { mult: number }).mult, t, 0.015);
    }
    this.engineFilter.frequency.setTargetAtTime(350 + throttle * 2600 + rpm * 0.25, t, 0.03);
    // Al limitatore il volume "balbetta"
    const stutter = limiter && Math.random() < 0.5 ? 0.45 : 1;
    this.engineGain.gain.setTargetAtTime((0.1 + throttle * 0.22) * stutter, t, 0.03);

    const squeal = Math.max(0, Math.min(1, (maxSlip - 0.85) * 1.6)) * Math.min(1, speed / 8);
    this.squealGain.gain.setTargetAtTime(squeal * 0.16, t, 0.05);
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
