import asyncio
import ast
import logging
import modal
import time
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
import numpy as np
import cv2
import pathlib
import os
import json
from typing import Optional, List
from fastapi.responses import Response

# Modal image with dependencies
WEIGHTS_PATH = "/tmp/Ultralytics/cache/assets/sam2.1_b.pt"

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("libgl1", "libglib2.0-0", "libsm6", "libxrender1", "libxext6")
    .pip_install(
        "torch~=2.4.1",
        "torchvision==0.19.1",
        "ultralytics==8.3.176",
        "opencv-python==4.10.0.84",
        "fastapi>=0.95.0",
        "python-multipart",
    )
    .env(
        {
            "ULTRALYTICS_HOME": "/tmp/Ultralytics/cache",
            "YOLO_CONFIG_DIR": "/tmp/Ultralytics",
        }
    )
)

app = modal.App("sam-api", image=image)

# Cache model weights between runs
CACHE_VOL = modal.Volume.from_name("ULTRALYTICS_CACHE", create_if_missing=True)


@app.cls(
    image=image,
    gpu="L4",
    volumes={"/tmp/Ultralytics/cache": CACHE_VOL},
    scaledown_window=60,
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
class Segmenter:
    @modal.enter(snap=True)
    def load_model(self):
        from ultralytics.models.sam import SAM2Predictor
        from ultralytics.utils.downloads import attempt_download_asset

        model_load_start = time.time()

        # Ensure cache directory exists, including the 'assets' subdirectory
        os.makedirs("/tmp/Ultralytics/cache/assets", exist_ok=True)

        if not os.path.exists(WEIGHTS_PATH):
            print(f"Downloading weights to {WEIGHTS_PATH}")
            attempt_download_asset(
                "sam2.1_b.pt", repo="ultralytics/assets", release="v8.3.0"
            )
        else:
            print(f"Using cached weights at {WEIGHTS_PATH}")

        # This ensures SAM2Predictor loads from where attempt_download_asset saved it.
        overrides = dict(
            conf=0.25, task="segment", mode="predict", imgsz=1024, model=WEIGHTS_PATH
        )
        self.predictor = SAM2Predictor(overrides=overrides)

        model_load_time = time.time() - model_load_start
        print(f"Model loading time: {model_load_time:.2f}s")

    @modal.method()
    def segment(
        self,
        img_bytes: bytes,
        points: Optional[List[List[int]]] = None,
        labels: Optional[List[int]] = None,
        bboxes: Optional[List[int]] = None,
    ):
        start_time = time.time()

        print(
            f"Received parameters - points: {points}, labels: {labels}, bboxes: {bboxes}"
        )

        # Image decoding
        decode_start = time.time()
        arr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        decode_time = time.time() - decode_start

        # Set image in predictor (only needs to be done once per image)
        set_image_start = time.time()
        self.predictor.set_image(img)
        set_image_time = time.time() - set_image_start

        # Model inference with points or bounding boxes
        inference_start = time.time()
        if bboxes is not None:
            # Use bounding box prompt
            results = self.predictor(bboxes=[bboxes])
        elif points is not None:
            # Use point prompts
            # Ensure labels are provided, default to all foreground (1) if not
            if labels is None:
                labels = (
                    [1] * len(points) if isinstance(points[0], (list, tuple)) else [1]
                )

            print(f"Calling predictor with points: {points}, labels: {labels}")
            results = self.predictor(points=points, labels=labels)
        else:
            # Default to everything mode if no prompts provided
            results = self.predictor()

        inference_time = time.time() - inference_start

        # Extract mask data and convert to GeoJSON
        mask_processing_start = time.time()
        features = []

        # The fix: Iterate through all results objects and their contained masks
        if results and len(results) > 0:
            for result in results:
                if result.masks is not None:
                    masks_np = result.masks.data.cpu().numpy()

                    print(f"Number of masks detected: {len(masks_np)}")

                    # Process all detected masks
                    for i, mask in enumerate(masks_np):
                        print(f"Processing mask {i}")

                        # Convert mask to binary uint8 format for OpenCV
                        mask_uint8 = (mask * 255).astype(np.uint8)

                        # Find contours of the mask using OpenCV
                        contours, _ = cv2.findContours(
                            mask_uint8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
                        )
                        print(f"Number of contours for mask {i}: {len(contours)}")

                        # Convert contours to GeoJSON features
                        for j, contour in enumerate(contours):
                            print(
                                f"Processing contour {j} for mask {i}, contour shape: {contour.shape}"
                            )
                            coordinates = [
                                [float(point[0][0]), float(-point[0][1])]
                                for point in contour
                            ]
                            coordinates.append(coordinates[0])

                            feature = {
                                "type": "Feature",
                                "geometry": {
                                    "type": "Polygon",
                                    "coordinates": [coordinates],
                                },
                                "properties": {"mask_id": i, "contour_id": j},
                            }
                            features.append(feature)

        print(f"Total number of features created: {len(features)}")

        geojson = {"type": "FeatureCollection", "features": features}

        result = json.dumps(geojson)
        mask_processing_time = time.time() - mask_processing_start

        total_time = time.time() - start_time

        print(f"Total segmentation time: {total_time:.2f}s")
        print(f"Image decoding: {decode_time:.2f}s")
        print(f"Set image time: {set_image_time:.2f}s")
        print(f"Model inference: {inference_time:.2f}s")
        print(f"Mask processing: {mask_processing_time:.2f}s")
        print(f"Input points: {points}")

        return result


# FastAPI Entry Point
web_app = FastAPI()

# CORS for browser clients (frontend dev and production)
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "https://deadtrees.earth",
    "https://www.deadtrees.earth",
]

web_app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,  # or use allow_origin_regex for wildcards
    allow_credentials=False,  # set True only if using cookies
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
    max_age=86400,
)

# Create a single instance of the segmenter class that will be reused
segmenter_instance = Segmenter()


@web_app.post("/segment")
async def segment_endpoint(
    image: UploadFile = File(...),
    points: str = Form(None),
    labels: str = Form(None),
    bboxes: str = Form(None),
    x: int = Form(None),
    y: int = Form(None),
):
    start_time = time.time()

    # File reading
    read_start = time.time()
    img_bytes = await image.read()
    read_time = time.time() - read_start

    try:
        # Segmentation
        segmentation_start = time.time()

        # Parse JSON strings if provided
        parsed_points = None
        parsed_labels = None
        parsed_bboxes = None

        print(f"Raw input - points: {points}, labels: {labels}, bboxes: {bboxes}")

        if points:
            parsed_points = json.loads(points)
            print(f"Parsed points: {parsed_points}")
        elif x is not None and y is not None:
            # Fallback to original x, y parameters for backward compatibility
            parsed_points = [x, y]

        if labels:
            parsed_labels = json.loads(labels)
            print(f"Parsed labels: {parsed_labels}")

        if bboxes:
            parsed_bboxes = json.loads(bboxes)
            print(f"Parsed bboxes: {parsed_bboxes}")

        print(
            f"About to call remote with: points={parsed_points}, labels={parsed_labels}, bboxes={parsed_bboxes}"
        )

        # Use the class instance created outside the endpoint
        mask_bytes = segmenter_instance.segment.remote(
            img_bytes, parsed_points, parsed_labels, parsed_bboxes
        )

        segmentation_time = time.time() - segmentation_start

        total_time = time.time() - start_time

        print(f"Total endpoint time: {total_time:.2f}s")
        print(f"File reading: {read_time:.2f}s")
        print(f"Segmentation (remote): {segmentation_time:.2f}s")

        return Response(content=mask_bytes, media_type="application/json")

    except Exception as e:
        print(f"Error in segmentation: {str(e)}")
        return {"error": str(e)}


@app.function(image=image)
@modal.asgi_app()
def fastapi_app():
    return web_app
