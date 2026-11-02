"""SAM 3 on the GPU: box and click segmentation, and text concept search.

Both model parts load on first use and are released after an idle period, so the
processing server's GPU memory is held only while someone labels.
"""

import os

import numpy as np
import torch

CHECKPOINT = os.environ.get('SAM_CHECKPOINT', os.path.expanduser('~/models/sam3'))
DTYPE = torch.bfloat16


class SamModels:
	def __init__(self, checkpoint: str = CHECKPOINT):
		self.checkpoint = checkpoint
		self.tracker = self.tracker_processor = self.concept = self.concept_processor = None
		self._embedding_key = None
		self._embedding = None
		self._sizes = None
		# The last outline per image and box, fed back into the next click as SAM's own loop does.
		self._prior = None

	@property
	def loaded(self) -> bool:
		return self.tracker is not None

	def load(self) -> None:
		from transformers import Sam3Model, Sam3Processor, Sam3TrackerModel, Sam3TrackerProcessor

		if self.loaded:
			return
		kwargs = {'local_files_only': True}
		self.tracker = Sam3TrackerModel.from_pretrained(self.checkpoint, torch_dtype=DTYPE, **kwargs).cuda().eval()
		self.tracker_processor = Sam3TrackerProcessor.from_pretrained(self.checkpoint, **kwargs)
		self.concept = Sam3Model.from_pretrained(self.checkpoint, torch_dtype=DTYPE, **kwargs).cuda().eval()
		self.concept_processor = Sam3Processor.from_pretrained(self.checkpoint, **kwargs)

	def unload(self) -> None:
		self.tracker = self.tracker_processor = self.concept = self.concept_processor = None
		self._embedding = self._embedding_key = self._sizes = self._prior = None
		torch.cuda.empty_cache()

	@torch.inference_mode()
	def segment(self, image, image_key: str, box=None, points=None, labels=None) -> list[np.ndarray]:
		"""One outline from a box and/or clicks (label 1 adds, 0 removes)."""
		if image_key != self._embedding_key:
			inputs = self.tracker_processor(images=image, return_tensors='pt').to('cuda')
			self._embedding = self.tracker.get_image_embeddings(inputs['pixel_values'].to(DTYPE))
			self._sizes, self._embedding_key = inputs['original_sizes'], image_key
		prompts = {}
		if points:
			prompts.update(input_points=[[points]], input_labels=[[labels]])
		if box:
			prompts['input_boxes'] = [[box]]
		inputs = self.tracker_processor(images=image, return_tensors='pt', **prompts).to('cuda')
		inputs.pop('pixel_values')
		inputs.pop('original_sizes', None)
		prior_key = (image_key, tuple(box) if box else None)
		refining = bool(points) and self._prior is not None and self._prior[0] == prior_key
		if refining:
			inputs['input_masks'] = self._prior[1]
		multimask = not refining and not (points and len(points) > 1)
		out = self.tracker(**inputs, image_embeddings=self._embedding, multimask_output=multimask)
		masks = self.tracker_processor.post_process_masks(out.pred_masks.float().cpu(), self._sizes.cpu())[0][0].numpy()
		best = int(out.iou_scores[0, 0].float().argmax()) if multimask else 0
		self._prior = (prior_key, out.pred_masks[0, 0, best][None, None].to(DTYPE))
		return [masks[best].astype(bool)]

	@torch.inference_mode()
	def find(self, image, text: str, threshold: float) -> tuple[list[np.ndarray], list[float]]:
		"""Every instance of a concept such as "tree", with its score."""
		inputs = self.concept_processor(images=image, text=text, return_tensors='pt').to('cuda')
		inputs['pixel_values'] = inputs['pixel_values'].to(DTYPE)
		out = self.concept(**inputs)
		result = self.concept_processor.post_process_instance_segmentation(
			out, threshold=threshold, mask_threshold=0.5, target_sizes=[(image.height, image.width)]
		)[0]
		return list(result['masks'].cpu().numpy().astype(bool)), result['scores'].float().cpu().tolist()
