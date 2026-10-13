/*
 * capture-worklet.js — AudioWorkletProcessor that mixes the input to mono,
 * downsamples to 16 kHz with a box filter, and posts PCM16 buffers of
 * `chunkSeconds` seconds to the main thread (which wraps them as WAV).
 *
 * Messages in:  { type: 'flush' }  → emit whatever is buffered, flagged final.
 * Messages out: { type: 'chunk', samples: Int16Array, final: boolean }
 */
class PCM16Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.chunkSamples = Math.round(this.targetRate * (opts.chunkSeconds || 5));
    this.ratio = sampleRate / this.targetRate; // e.g. 3 for 48 kHz, 2.756 for 44.1 kHz
    this.buf = new Int16Array(this.chunkSamples);
    this.len = 0;
    this.acc = 0; // running sum of input samples for the current output sample
    this.accN = 0; // how many input samples are in `acc`
    this.pos = 0; // fractional position inside the current output sample
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'flush') this.emit(true);
    };
  }

  emit(final) {
    const out = this.buf.slice(0, this.len);
    this.port.postMessage({ type: 'chunk', samples: out, final: !!final }, [out.buffer]);
    this.len = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      this.acc += s / channels;
      this.accN++;
      this.pos++;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let v = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        this.buf[this.len++] = v < 0 ? v * 32768 : v * 32767;
        if (this.len >= this.chunkSamples) this.emit(false);
      }
    }
    return true;
  }
}

registerProcessor('pcm16-downsampler', PCM16Downsampler);
