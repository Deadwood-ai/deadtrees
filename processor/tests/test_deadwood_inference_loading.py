from unittest.mock import Mock

import pytest


@pytest.mark.unit
def test_deadwood_model_loads_only_the_safetensors_checkpoint(monkeypatch):
	from processor.src.deadwood_segmentation_v1_moehring.inference import deadwood_inference

	model = Mock()
	model.to.return_value = model
	model.eval.return_value = model
	model_constructor = Mock(return_value=model)
	load_model = Mock()

	monkeypatch.setattr(deadwood_inference.smp, 'Unet', model_constructor)
	monkeypatch.setattr(deadwood_inference.safetensors.torch, 'load_model', load_model)
	monkeypatch.setattr(deadwood_inference.torch, 'compile', lambda value, **_kwargs: value)
	monkeypatch.setattr(deadwood_inference.torch.cuda, 'is_available', lambda: False)

	inference = deadwood_inference.DeadwoodInference('/models/checkpoint.safetensors')

	model_constructor.assert_called_once_with(
		encoder_name='mit_b5',
		encoder_weights=None,
		in_channels=3,
		classes=1,
	)
	load_model.assert_called_once_with(model, '/models/checkpoint.safetensors')
	assert inference.model is model
