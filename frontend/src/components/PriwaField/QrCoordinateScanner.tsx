import { Alert, Button, Space } from "antd";
import { CameraOutlined, StopOutlined } from "@ant-design/icons";
import jsQR from "jsqr";
import { useCallback, useEffect, useRef, useState } from "react";

const getCameraErrorMessage = (error: unknown) => {
  const errorName =
    error instanceof DOMException || error instanceof Error ? error.name : "";

  if (!window.isSecureContext) {
    return "Kamera braucht HTTPS oder localhost. Bitte diese Testversion über eine sichere Adresse öffnen.";
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return "Dieser Browser unterstützt keinen direkten Kamerazugriff. Google-Maps-Link bitte manuell einfügen.";
  }

  if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    return "Kamera ist blockiert. Bitte Kamera für diese Website in den Browser-/Systemeinstellungen erlauben.";
  }

  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return "Keine Kamera gefunden. Google-Maps-Link bitte manuell einfügen.";
  }

  if (errorName === "NotReadableError" || errorName === "TrackStartError") {
    return "Kamera ist gerade nicht verfügbar. Bitte andere Kamera-Apps schließen und erneut versuchen.";
  }

  return "QR-Scan konnte nicht gestartet werden. Google-Maps-Link bitte manuell einfügen.";
};

interface QrCoordinateScannerProps {
  autoStart?: boolean;
  onDetected: (value: string) => void;
}

export default function QrCoordinateScanner({
  autoStart = false,
  onDetected,
}: QrCoordinateScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const hasAutoStartedRef = useRef(false);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopScanning = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsScanning(false);
  }, []);

  const scanFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (
      !video ||
      !canvas ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      animationFrameRef.current = window.requestAnimationFrame(scanFrame);
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      animationFrameRef.current = window.requestAnimationFrame(scanFrame);
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const qrCode = jsQR(imageData.data, imageData.width, imageData.height);

    if (qrCode?.data) {
      onDetected(qrCode.data);
      stopScanning();
      return;
    }

    animationFrameRef.current = window.requestAnimationFrame(scanFrame);
  }, [onDetected, stopScanning]);

  const startScanning = useCallback(async () => {
    stopScanning();

    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
        },
        audio: false,
      });

      streamRef.current = stream;
      setIsScanning(true);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      animationFrameRef.current = window.requestAnimationFrame(scanFrame);
    } catch (scanError) {
      setError(getCameraErrorMessage(scanError));
      stopScanning();
    }
  }, [scanFrame, stopScanning]);

  useEffect(() => {
    if (!autoStart || hasAutoStartedRef.current) return;

    hasAutoStartedRef.current = true;
    void startScanning();
  }, [autoStart, startScanning]);

  useEffect(() => stopScanning, [stopScanning]);

  return (
    <div className="space-y-3">
      {error && <Alert type="warning" showIcon message={error} />}
      <div className="overflow-hidden rounded-md bg-black">
        <video
          ref={videoRef}
          className="aspect-video w-full object-cover"
          muted
          playsInline
        />
      </div>
      <canvas ref={canvasRef} className="hidden" />
      <Space>
        <Button
          icon={<CameraOutlined />}
          onClick={startScanning}
          disabled={isScanning}
        >
          Kamera starten
        </Button>
        <Button
          icon={<StopOutlined />}
          onClick={stopScanning}
          disabled={!isScanning}
        >
          Stop
        </Button>
      </Space>
    </div>
  );
}
