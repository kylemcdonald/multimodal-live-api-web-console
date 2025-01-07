/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MultimodalLiveAPIClientConnection,
  MultimodalLiveClient,
} from "../lib/multimodal-live-client";
import { LiveConfig } from "../multimodal-live-types";
import { AudioStreamer } from "../lib/audio-streamer";
import { audioContext } from "../lib/utils";
import VolMeterWorket from "../lib/worklets/vol-meter";

export type UseLiveAPIResults = {
  client: MultimodalLiveClient;
  setConfig: (config: LiveConfig) => void;
  config: LiveConfig;
  connected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  volume: number;
};

export function useLiveAPI({
  url,
  apiKey,
}: MultimodalLiveAPIClientConnection): UseLiveAPIResults {
  const client = useMemo(
    () => new MultimodalLiveClient({ url, apiKey }),
    [url, apiKey],
  );
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const [audioInitialized, setAudioInitialized] = useState(false);

  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<LiveConfig>({
    model: "models/gemini-2.0-flash-exp",
  });
  const [volume, setVolume] = useState(0);

  // Initialize audio context and streamer on first user interaction
  const initializeAudio = useCallback(async () => {
    if (!audioStreamerRef.current) {
      try {
        const audioCtx = await audioContext({ id: "audio-out" });
        const streamer = new AudioStreamer(audioCtx);
        await streamer.addWorklet<any>("vumeter-out", VolMeterWorket, (ev: any) => {
          setVolume(ev.data.volume);
        });
        audioStreamerRef.current = streamer;
        setAudioInitialized(true);
      } catch (error) {
        console.error('Failed to initialize audio:', error);
      }
    }
  }, []);

  // Add interaction listeners for iOS
  useEffect(() => {
    const handleInteraction = () => {
      initializeAudio();
    };

    window.addEventListener('touchstart', handleInteraction, { once: true });
    window.addEventListener('click', handleInteraction, { once: true });
    window.addEventListener('keydown', handleInteraction, { once: true });

    return () => {
      window.removeEventListener('touchstart', handleInteraction);
      window.removeEventListener('click', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
    };
  }, [initializeAudio]);

  useEffect(() => {
    const onClose = () => {
      setConnected(false);
    };

    const stopAudioStreamer = () => {
      if (audioStreamerRef.current) {
        audioStreamerRef.current.stop();
      }
    };

    const onAudio = async (data: ArrayBuffer) => {
      if (!audioStreamerRef.current) {
        await initializeAudio();
      }
      audioStreamerRef.current?.addPCM16(new Uint8Array(data));
    };

    client
      .on("close", onClose)
      .on("interrupted", stopAudioStreamer)
      .on("audio", onAudio);

    return () => {
      client
        .off("close", onClose)
        .off("interrupted", stopAudioStreamer)
        .off("audio", onAudio);
    };
  }, [client, initializeAudio]);

  const connect = useCallback(async () => {
    await initializeAudio();  // Ensure audio is initialized on connect
    if (audioStreamerRef.current) {
      await audioStreamerRef.current.resume();
    }
    await client.connect(config);  // Add config argument
    setConnected(true);
  }, [client, initializeAudio, config]);

  const disconnect = useCallback(async () => {  // Make async
    await client.disconnect();
    if (audioStreamerRef.current) {
      await audioStreamerRef.current.stop();
    }
    setConnected(false);
  }, [client]);

  return {
    client,
    connected,
    connect,
    disconnect,
    volume,
    config,
    setConfig,
  };
}
