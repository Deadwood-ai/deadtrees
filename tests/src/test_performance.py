import os
import time
import httpx


# get some basic config from os variables
COG_URL = os.environ.get("COG_URL", "http://nginx:80/cogs/v1")

def test_load_small_tiff():
    times = []

    for i in range(100):
        start = time.time()
        response = httpx.get(f"{COG_URL}/test-data.tif", headers={"Range": "bytes=201-300"})
        assert len(response.read()) == 100
        times.append(time.time() - start)

    avg_request_time = sum(times) / len(times)
    std_request_time = avg_request_time * len(times) ** 0.5
    print(f"Average time: {avg_request_time}   Std dev: {std_request_time}")

    assert avg_request_time < 0.1
    return True

