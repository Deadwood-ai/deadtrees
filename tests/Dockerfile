FROM python:3.12.1

# This is only needed if we use the approach below
# RUN apt-get update && apt-get install -y gdal-bin libgdal-dev && \
#     pip install --upgrade pip && \
#     pip install GDAL==$(gdal-config --version | awk -F'[.]' '{print $1"."$2}')

# create a folder for the application
# this is only needed if we need to *import* functions in the tests
RUN mkdir -p /app/tests
# COPY ./shared /app/shared
# COPY ./api /app/api
# COPY ./processor /app/processor
# COPY ./run.py /app/run.py

# install everything
# RUN pip install --upgrade pip && \
#     pip install -r /app/api/requirements.txt && \
#     pip install -r /app/processor/requirements.txt

# make the dedicated test location
COPY ./tests /app/tests
RUN pip install -r /app/tests/requirements.txt

WORKDIR /app/tests/src
CMD ["python", "pytest"]