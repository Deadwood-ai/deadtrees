import os

import httpx


# get some basic config from os variables
COG_URL = os.environ.get("COG_URL", "http://nginx:80/cogs/v1")

def test_load_small_tiff():
    response = httpx.get(f"{COG_URL}/test-data-small.tif")

    assert response.status_code == 200
    return True

