from unittest.mock import Mock

import pytest
import torch


@pytest.mark.unit
def test_deadwood_model_loads_the_compiled_safetensors_checkpoint_into_a_plain_model(monkeypatch):
	from processor.src.deadwood_segmentation_v1_moehring.inference import deadwood_inference

	model = Mock()
	model.to.return_value = model
	model.eval.return_value = model
	model_constructor = Mock(return_value=model)
	weights = torch.zeros(1)
	load_file = Mock(return_value={'_orig_mod.decoder.weight': weights, 'segmentation_head.bias': weights})

	monkeypatch.setattr(deadwood_inference.smp, 'Unet', model_constructor)
	monkeypatch.setattr(deadwood_inference.safetensors.torch, 'load_file', load_file)
	monkeypatch.setattr(deadwood_inference.torch.cuda, 'is_available', lambda: False)

	inference = deadwood_inference.DeadwoodInference('/models/checkpoint.safetensors')

	model_constructor.assert_called_once_with(
		encoder_name='mit_b5',
		encoder_weights=None,
		in_channels=3,
		classes=1,
	)
	load_file.assert_called_once_with('/models/checkpoint.safetensors')
	model.load_state_dict.assert_called_once_with({'decoder.weight': weights, 'segmentation_head.bias': weights})
	model.to.assert_called_once_with(device=torch.device('cpu'), dtype=torch.float32, memory_format=torch.channels_last)
	assert inference.model is model
