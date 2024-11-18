import React, { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeClient } from "@openai/realtime-api-beta";
import { SimliClient } from "simli-client";
import VideoBox from "./Components/VideoBox";
import cn from "./utils/TailwindMergeAndClsx";
import IconExit from "@/media/IconExit";
import IconSparkleLoader from "@/media/IconSparkleLoader";

interface SimliOpenAIProps {
  simli_faceid: string;
  openai_voice: "echo" | "alloy" | "shimmer";
  initialPrompt: string;
  onStart: () => void;
  onClose: () => void;
  showDottedFace: boolean;
}

const simliClient = new SimliClient();

const SimliOpenAI: React.FC<SimliOpenAIProps> = ({
  simli_faceid,
  openai_voice,
  initialPrompt,
  onStart,
  onClose,
  showDottedFace,
}) => {
  // State management
  const [isLoading, setIsLoading] = useState(false);
  const [isAvatarVisible, setIsAvatarVisible] = useState(false);
  const [error, setError] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [userMessage, setUserMessage] = useState("...");
  const [isSimliConnected, setIsSimliConnected] = useState(true);
  const [isReconnectingSimli, setIsReconnectingSimli] = useState(false);

  // Refs for various components and states
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const openAIClientRef = useRef<RealtimeClient | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const isSecondRun = useRef(false);

  // New refs for managing audio chunk delay
  const audioChunkQueueRef = useRef<Int16Array[]>([]);
  const isProcessingChunkRef = useRef(false);

  // Initialize the Simli client
  const initializeSimliClient = useCallback(() => {
    if (videoRef.current && audioRef.current) {
      const SimliConfig = {
        apiKey: process.env.NEXT_PUBLIC_SIMLI_API_KEY,
        faceID: simli_faceid,
        handleSilence: true,
        maxSessionLength: 60, // in seconds
        maxIdleTime: 60, // in seconds
        videoRef: videoRef,
        audioRef: audioRef,
      };

      simliClient.Initialize(SimliConfig as any);
      console.log("Simli Client initialized");
    }
  }, [simli_faceid]);

  // Initialize OpenAI Client
  const initializeOpenAIClient = useCallback(async () => {
    try {
      console.log("Initializing OpenAI client...");
      openAIClientRef.current = new RealtimeClient({
        apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY,
        dangerouslyAllowAPIKeyInBrowser: true,
      });

      await openAIClientRef.current.updateSession({
        instructions: initialPrompt,
        voice: openai_voice,
        turn_detection: { type: "server_vad" },
        input_audio_transcription: { model: "whisper-1" },
      });

      openAIClientRef.current.on("conversation.updated", handleConversationUpdate);
      openAIClientRef.current.on("conversation.interrupted", interruptConversation);
      openAIClientRef.current.on("input_audio_buffer.speech_stopped", handleSpeechStopped);

      await openAIClientRef.current.connect().then(() => {
        console.log("OpenAI Client connected successfully");
        startRecording();
      });

      setIsAvatarVisible(true);
    } catch (error: any) {
      console.error("Error initializing OpenAI client:", error);
      setError(`Failed to initialize OpenAI client: ${error.message}`);
    }
  }, [initialPrompt]);

  // Handle conversation updates
  const handleConversationUpdate = useCallback((event: any) => {
    const { item, delta } = event;

    if (item.type === "message" && item.role === "assistant") {
      if (delta && delta.audio) {
        const downsampledAudio = downsampleAudio(delta.audio, 24000, 16000);
        audioChunkQueueRef.current.push(downsampledAudio);
        if (!isProcessingChunkRef.current) {
          processNextAudioChunk();
        }
      }
    } else if (item.type === "message" && item.role === "user") {
      setUserMessage(item.content[0].transcript);
    }
  }, []);

  // Handle interruptions in the conversation flow
  const interruptConversation = () => {
    console.warn("User interrupted the conversation");
    simliClient?.ClearBuffer();
    openAIClientRef.current?.cancelResponse("");
  };

  // Process next audio chunk in the queue
  const processNextAudioChunk = useCallback(() => {
    if (audioChunkQueueRef.current.length > 0 && !isProcessingChunkRef.current) {
      isProcessingChunkRef.current = true;
      const audioChunk = audioChunkQueueRef.current.shift();
      if (audioChunk) {
        const chunkDurationMs = (audioChunk.length / 16000) * 1000;
        simliClient?.sendAudioData(audioChunk as any);
        isProcessingChunkRef.current = false;
        processNextAudioChunk();
      }
    }
  }, []);

  // Handle speech stopped event
  const handleSpeechStopped = useCallback((event: any) => {
    console.log("Speech stopped event received", event);
  }, []);

  // Handle Simli disconnection
  const handleSimliDisconnect = () => {
    console.log("Simli disconnected. Pausing OpenAI...");
    setIsSimliConnected(false);
    setIsReconnectingSimli(true);
    pauseOpenAI();
  };

  // Handle Simli reconnection
  const handleSimliReconnect = () => {
    console.log("Simli reconnected. Resuming OpenAI...");
    setIsSimliConnected(true);
    setIsReconnectingSimli(false);
    resumeOpenAI();
  };

  // Pause OpenAI (Mute or stop further conversation updates)
  const pauseOpenAI = () => {
    if (openAIClientRef.current) {
      openAIClientRef.current.pause(); // Assuming there's a pause API method or handle this logic manually
    }
  };

  // Resume OpenAI conversation
  const resumeOpenAI = () => {
    if (openAIClientRef.current) {
      openAIClientRef.current.resume(); // Assuming there's a resume API method or handle this logic manually
    }
  };

  // Start recording from the user's microphone
  const startRecording = useCallback(async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
    }

    try {
      console.log("Starting audio recording...");
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const source = audioContextRef.current.createMediaStreamSource(streamRef.current);
      processorRef.current = audioContextRef.current.createScriptProcessor(2048, 1, 1);

      processorRef.current.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const audioData = new Int16Array(inputData.length);
        let sum = 0;

        for (let i = 0; i < inputData.length; i++) {
          const sample = Math.max(-1, Math.min(1, inputData[i]));
          audioData[i] = Math.floor(sample * 32767);
          sum += Math.abs(sample);
        }

        openAIClientRef.current?.appendInputAudio(audioData);
      };

      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);
      setIsRecording(true);
      console.log("Audio recording started");
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setError("Error accessing microphone. Please check your permissions.");
    }
  }, []);

  // Stop recording
  const stopRecording = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsRecording(false);
    console.log("Audio recording stopped");
  }, []);

  // Handle start of interaction
  const handleStart = useCallback(async () => {
    setIsLoading(true);
    setError("");
    onStart();

    try {
      initializeSimliClient();
      await simliClient?.start();
    } catch (error: any) {
      console.error("Error starting interaction:", error);
      setError(`Error starting interaction: ${error.message}`);
    } finally {
      setIsAvatarVisible(true);
      setIsLoading(false);
    }
  }, [onStart]);

  // Handle stop of interaction
  const handleStop = useCallback(() => {
    console.log("Stopping interaction...");
    setIsLoading(false);
    setError("");
    stopRecording();
    setIsAvatarVisible(false);
    simliClient?.close();
    openAIClientRef.current?.disconnect();
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    onClose();
  }, [onClose, stopRecording]);

  useEffect(() => {
    simliClient?.on("disconnected", handleSimliDisconnect);
    simliClient?.on("connected", handleSimliReconnect);

    return () => {
      simliClient?.off("disconnected", handleSimliDisconnect);
      simliClient?.off("connected", handleSimliReconnect);
    };
  }, []);

  return (
    <>
      {isReconnectingSimli && (
        <div role="alert" className="rounded border-s-4 border-yellow-500 bg-yellow-50 p-4">
  <strong className="block font-medium text-gray-500"> Reconnecting... Please wait.</strong>
</div>
      )}

      <div
        className={`transition-all duration-300 ${showDottedFace ? "h-0 overflow-hidden" : "h-auto"}`}
      >
        <VideoBox video={videoRef} audio={audioRef} />
      </div>
      <div className="flex flex-col items-center">
        {!isAvatarVisible ? (
          <button
            onClick={handleStart}
            disabled={isLoading}
            className={cn(
              "w-full h-[52px] mt-4 disabled:bg-[#343434] disabled:text-white disabled:hover:rounded-[100px] bg-simliblue text-white py-3 px-6 rounded-[100px] transition-all duration-300 hover:text-black hover:bg-white hover:rounded-sm",
              "flex justify-center items-center"
            )}
          >
            {isLoading ? (
              <IconSparkleLoader className="h-[20px] animate-loader" />
            ) : (
              <span className="font-abc-repro-mono font-bold w-[164px]">
                Test Interaction
              </span>
            )}
          </button>
        ) : (
          <>
            <div className="flex items-center gap-4 w-full">
              <button
                onClick={handleStop}
                className={cn(
                  "mt-4 group text-white flex-grow bg-red hover:rounded-sm hover:bg-white h-[52px] px-6 rounded-[100px] transition-all duration-300"
                )}
              >
                <span className="font-abc-repro-mono group-hover:text-black font-bold w-[164px] transition-all duration-300">
                  Stop Interaction
                </span>
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
};

export default SimliOpenAI;
