class PhotoPassAudioCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.used = 0;
  }
  process(inputs) {
    const mono = inputs[0]?.[0];
    if (mono) {
      let pos = 0;
      while (pos < mono.length) {
        const count = Math.min(mono.length - pos, this.samples.length - this.used);
        this.samples.set(mono.subarray(pos, pos + count), this.used);
        this.used += count;
        pos += count;
        if (this.used === this.samples.length) {
          this.port.postMessage(this.samples, [this.samples.buffer]);
          this.samples = new Float32Array(2048);
          this.used = 0;
        }
      }
    }
    return true; // Output buffers stay silent. No microphone feedback.
  }
}
registerProcessor('photopass-audio-capture', PhotoPassAudioCapture);
