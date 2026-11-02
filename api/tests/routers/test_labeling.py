from fastapi.testclient import TestClient

from api.src.server import app

client = TestClient(app)


def test_sam_requests_need_a_signed_in_session(auth_token):
	assert client.get('/labeling/sam-authorize').status_code == 401
	assert client.get('/labeling/sam-authorize', headers={'Authorization': 'Bearer not-a-token'}).status_code == 401
	response = client.get('/labeling/sam-authorize', headers={'Authorization': f'Bearer {auth_token}'})
	assert response.status_code == 204
