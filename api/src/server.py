from fastapi import FastAPI, Response
from starlette.middleware.cors import CORSMiddleware

from shared import monitoring
import logging

from shared.__version__ import __version__
from .routers import process, upload, info, auth, labels, download, dte_stats

app = FastAPI(
	title='Deadwood-AI API',
	description='This is the Deadwood-AI API. It is used to manage files uploads to the Deadwood-AI backend and the preprocessing of uploads. Note that the download is managed by a sub-application at `/download/`.',
	version=__version__,
	root_path='/api/v1',
)

# monitoring.logfire.instrument_fastapi(app)
# logging.basicConfig(level=logging.INFO)

# Comprehensive CORS configuration
app.add_middleware(
	CORSMiddleware,
	allow_origins=[
		'https://deadtrees.earth',
		'https://www.deadtrees.earth',
		'http://10.4.113.132:5173',
		'http://localhost:5173',
	],
    allow_origin_regex='https://deadwood-d4a4b.*|http://(127\\.0\\.0\\.1|localhost)(:\\d+)?',
	allow_credentials=True,
	allow_methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	allow_headers=['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
	expose_headers=['Content-Length', 'Content-Range'],
	max_age=3600,
)


# add the info route to the app
app.include_router(info.router)

# add the upload route to the app
app.include_router(upload.router)


# add the auth rout to the app
app.include_router(auth.router)

# add the processing to the app
app.include_router(process.router)

# add the labels to the app
# app.include_router(labels.router)

# add thumbnail route to the app
# app.include_router(thumbnail.router)


# add the DTE stats route (public, no auth)
app.include_router(dte_stats.router)

# add the download routes to the app
# app.include_router(download.download_app)
app.mount('/download', download.download_app)
