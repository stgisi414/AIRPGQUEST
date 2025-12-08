import { LyriaConfig, generateMusicConfig, MusicScale, MusicGenerationMode } from "./conductor";
import { GoogleGenAI } from "@google/genai";

export class MusicEngine {
  private audioContext: AudioContext | null = null;
  private nextStartTime: number = 0;
  private apiKey: string;
  private isPlaying: boolean = false;
  private currentConfig: LyriaConfig | null = null;
  private session: any | null = null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  public async play() {
    if (this.isPlaying) return;

    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 44100, // Matching the documentation sample rate
      });
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.isPlaying = true;
    this.nextStartTime = this.audioContext.currentTime + 0.1;
    
    await this.connectToLyria();
  }

  private async connectToLyria() {
    if (!this.apiKey) {
      console.warn("MusicEngine: No API key provided. Music generation disabled.");
      this.isPlaying = false;
      return;
    }

    try {
        const client = new GoogleGenAI({ apiKey: this.apiKey, apiVersion: "v1alpha" });
        
        // Use the structure from the documentation: client.live.music.connect
        this.session = await (client as any).live.music.connect({
            model: "models/lyria-realtime-exp",
            callbacks: {
                onmessage: (message: any) => {
                    if (message.serverContent?.audioChunks) {
                        for (const chunk of message.serverContent.audioChunks) {
                            if (chunk.data) {
                                this.processAudioChunk(chunk.data);
                            }
                        }
                    }
                },
                onerror: (error: any) => console.error("music session error:", error),
                onclose: () => console.log("Lyria RealTime stream closed."),
            }
        });

        console.log("Connected to Lyria Music Engine.");

        // Initial default config
        await this.updateSituation("The adventure begins in a quiet forest.");

        // Start playback on the session side as per doc
        await this.session.play();

    } catch (e) {
        console.error("Failed to connect to Music Engine:", e);
        this.isPlaying = false;
    }
  }

  public async updateSituation(situation: string) {
    if (!this.isPlaying || !this.session) return;
    if (!this.apiKey) return;

    try {
        const newConfig = await generateMusicConfig(situation, this.apiKey);
        if (!newConfig) return;

        // Apply weighted prompts
        await this.session.setWeightedPrompts({ weightedPrompts: newConfig.weightedPrompts });

        // Apply config
        const shouldReset = this.shouldResetContext(newConfig);
        await this.session.setMusicGenerationConfig({ 
            musicGenerationConfig: {
                bpm: newConfig.musicGenerationConfig.bpm,
                density: newConfig.musicGenerationConfig.density,
                scale: newConfig.musicGenerationConfig.scale,
                musicGenerationMode: newConfig.musicGenerationConfig.musicGenerationMode,
                audioFormat: "pcm16",
                sampleRateHz: 44100
            }
        });

        if (shouldReset) {
            console.log("Resetting context for drastic music change");
            await this.session.reset_context();
        }
        
        this.currentConfig = newConfig;
    } catch (err) {
        console.error("Error updating music situation:", err);
    }
  }

  private shouldResetContext(newConfig: LyriaConfig): boolean {
    if (!this.currentConfig) return false;
    
    const bpmDiff = Math.abs(newConfig.musicGenerationConfig.bpm - this.currentConfig.musicGenerationConfig.bpm);
    const scaleChanged = newConfig.musicGenerationConfig.scale !== this.currentConfig.musicGenerationConfig.scale;

    return bpmDiff > 20 || scaleChanged;
  }

  private processAudioChunk(base64Data: string) {
    if (!this.audioContext) return;

    // 1. Decode Base64 to ArrayBuffer
    const binaryString = window.atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const int16Data = new Int16Array(bytes.buffer);

    // 2. Convert Int16 to Float32
    const float32Data = new Float32Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) {
        // PCM 16-bit range is [-32768, 32767]
        float32Data[i] = int16Data[i] / 32768.0;
    }

    // 3. Create AudioBuffer (Mono or Stereo? Doc says Stereo/2 channels)
    // The decoded Int16 array contains interleaved samples if stereo.
    // Length / 2 = Number of frames
    const channels = 2;
    const frameCount = float32Data.length / channels;
    const buffer = this.audioContext.createBuffer(channels, frameCount, 44100);

    for (let channel = 0; channel < channels; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
            channelData[i] = float32Data[i * channels + channel];
        }
    }

    // 4. Schedule
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    const startTime = Math.max(this.audioContext.currentTime, this.nextStartTime);
    source.start(startTime);

    this.nextStartTime = startTime + buffer.duration;
  }

  public toggle(shouldPlay: boolean) {
    if (shouldPlay) {
        if (!this.isPlaying) {
             this.play();
        } else if (this.audioContext && this.audioContext.state === 'suspended') {
             this.audioContext.resume();
        }
    } else {
        // Just suspend audio context, don't necessarily kill the session to keep it warm
        // unless deep stop is requested.
        if (this.audioContext) this.audioContext.suspend();
    }
  }
}
