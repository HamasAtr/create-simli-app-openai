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
  const [isReconnecting, setIsReconnecting] = useState(false);

  // Refs for various components and states
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const openAIClientRef = useRef<RealtimeClient | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const conversationStateRef = useRef<any>(null);
  const simliClientRef = useRef<SimliClient | null>(null);

  // Refs for managing audio chunk delay
  const audioChunkQueueRef = useRef<Int16Array[]>([]);
  const isProcessingChunkRef = useRef(false);

  // Capture conversation state before pausing
  const captureConversationState = useCallback(() => {
    if (openAIClientRef.current) {
      conversationStateRef.current = {
        // Hypothetical methods - actual implementation depends on RealtimeClient API
        currentContext: openAIClientRef.current.getCurrentContext?.(),
        lastMessageTimestamp: Date.now()
      };
    }
  }, []);

  // Initialize the Simli client
  const initializeSimliClient = useCallback(async () => {
    try {
      simliClientRef.current = new SimliClient();
      
      if (videoRef.current && audioRef.current) {
        const SimliConfig = {
          apiKey: process.env.NEXT_PUBLIC_SIMLI_API_KEY,
          faceID: simli_faceid,
          handleSilence: true,
          maxSessionLength: 60,
          maxIdleTime: 60,
          videoRef: videoRef,
          audioRef: audioRef,
        };

        await simliClientRef.current.Initialize(SimliConfig as any);
        
        // Set up connection event listeners
        simliClientRef.current.on('disconnected', handleSimliDisconnect);
        simliClientRef.current.on('connected', handleSimliReconnect);

        console.log("Simli Client initialized");
      }
    } catch (error) {
      console.error("Error initializing Simli client:", error);
      setError(`Failed to initialize Simli client: ${error.message}`);
    }
  }, [simli_faceid]);

  // Handle Simli disconnection
  const handleSimliDisconnect = useCallback(async () => {
    console.log("Simli disconnected. Initiating recovery...");

    // 1. Pause OpenAI connection
    captureConversationState();
    openAIClientRef.current?.pause();

    // 2. Show reconnection banner
    setIsReconnecting(true);

    try {
      // 3. Re-establish Simli connection
      await simliClientRef.current?.reconnect();

      // 4. Resume OpenAI conversation from saved state
      if (conversationStateRef.current) {
        await openAIClientRef.current?.restoreContext?.(conversationStateRef.current.currentContext);
        openAIClientRef.current?.resume();
      }

      // 5. Hide reconnection banner
      setIsReconnecting(false);
    } catch (error) {
      console.error("Reconnection failed:", error);
      setError("Connection could not be re-established");
      onClose();
    }
  }, [captureConversationState, onClose]);

  // Handle Simli reconnection
  const handleSimliReconnect = useCallback(() => {
    console.log("Simli reconnected successfully");
    setIsReconnecting(false);
  }, []);

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

      // Add event listeners for conversation management
      openAIClientRef.current.on("conversation.updated", handleConversationUpdate);
      openAIClientRef.current.on("conversation.interrupted", interruptConversation);

      await openAIClientRef.current.connect();
      console.log("OpenAI Client connected successfully");
      
      startRecording();
      setIsAvatarVisible(true);
    } catch (error: any) {
      console.error("Error initializing OpenAI client:", error);
      setError(`Failed to initialize OpenAI client: ${error.message}`);
    }
  }, [initialPrompt, openai_voice]);

  // Other existing methods like handleConversationUpdate, startRecording, etc. remain the same

  // Handle start of interaction
  const handleStart = useCallback(async () => {
    setIsLoading(true);
    setError("");
    onStart();

    try {
      await initializeSimliClient();
      await initializeOpenAIClient();
      await simliClientRef.current?.start();
    } catch (error: any) {
      console.error("Error starting interaction:", error);
      setError(`Error starting interaction: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [onStart, initializeSimliClient, initializeOpenAIClient]);

  // Render method
  return (
    <>
      {isReconnecting && (
        <div role="alert" className="rounded border-s-4 border-yellow-500 bg-yellow-50 p-4">
          <strong className="block font-medium text-gray-500">
            Reconnecting... Please wait.
          </strong>
        </div>
      )}

      {/* Rest of the existing render logic */}
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
        )}
      </div>
    </>
  );
};

export default SimliOpenAI;
