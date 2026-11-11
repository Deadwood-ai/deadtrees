"""The question the vision models answer, and the parser that turns a reply into an
assessment. A changed prompt is a new PROMPT_VERSION (and check version)."""

import json
import re

from .rules import Call
from .vocabulary import CATEGORIES, FLAGS, MODEL_REASONS, VERDICTS

PROMPT_VERSION = 'v2'


class AnswerError(ValueError):
	"""The reply is not the requested JSON; the call is retried once."""


def _choices(values) -> str:
	return ' | '.join(values)


def build_prompt(overview_mpp: float, crop_mpp: float, has_thumbnail: bool, crop_count: int = 4) -> str:
	"""The question for one dataset. The image numbers follow the images actually sent:
	the overview, then `crop_count` samples (a small plot has fewer than four), then the thumbnail."""
	if crop_count == 0:
		samples = 'There are no full resolution samples of this orthophoto.'
	elif crop_count == 1:
		samples = f'Image 2 is one sample at full resolution, about {crop_mpp * 100:.1f} cm per pixel.'
	else:
		samples = (
			f'Images 2 to {crop_count + 1} are {crop_count} samples at full resolution, '
			f'about {crop_mpp * 100:.1f} cm per pixel.'
		)
	thumbnail = (
		f'Image {crop_count + 2} is the 256 px thumbnail the website shows for this dataset.\n' if has_thumbnail else ''
	)
	return f"""You check drone and aerial orthophotos for deadtrees.earth, a database that maps dead trees and
forest cover from this imagery and uses it to train satellite products.
Image 1 is the whole orthophoto at about {overview_mpp * 100:.0f} cm per pixel; black or empty areas are outside the
flight. {samples}
{thumbnail}Judge the whole orthophoto.
Decide whether the imagery can be used to map dead trees and forest cover.
- exclude: unusable as a whole. Only for these reasons:
  blurry (blurry or smeared throughout, crowns cannot be told apart at full resolution),
  no_trees (no trees or forest at all, e.g. water, fields, built-up area, a construction site),
  artifacts (severe reconstruction errors throughout: warping, ghosting, holes, stretched or melted areas),
  not_rgb (not a true colour photo: near-infrared or false colour, thermal, grayscale, one band),
  broken_ortho (mostly empty, black, cut off or only a few scattered pieces),
  too_dark (too dark or overexposed to see the trees),
  other (unusable for another reason you name in the summary).
- fix: usable, but one of these concrete problems should be fixed: cog_issue (display problems in the
  orthophoto: wrong colour stretch, black tiles, stripes), thumbnail_issue (the thumbnail is empty, black,
  wrong or unlike Image 1), reprocess (local reconstruction errors that reprocessing could fix: warped, torn
  or doubled areas). Bright, pale, dark or shadowed imagery is not a reason to fix: reprocessing does not
  change the light of the flight.
- keep: usable as it is. Small problems at the edges, a few artifacts, partial cloud or shadow are fine.
- unsure: you cannot tell from these images.
Not a reason to exclude: the season or leafless trees, the georeferencing, or another upload of the same
area. Other checks decide those.

Answer with this JSON only:
{{"verdict": "{_choices(VERDICTS)}",
 "exclude_likelihood": <0-100, how likely the dataset must be excluded>,
 "reason": "{_choices(MODEL_REASONS + ('none',))}",
 "flags": {{{', '.join(f'"{k}": <0-100>' for k in FLAGS)}}},
{chr(10).join(f' "{k}": "{_choices(v)}",' for k, v in CATEGORIES.items())}
 "summary": "<one sentence on what the imagery shows and why it is usable or not>"}}
Each flag is how likely that problem is present to a degree that matters. scene is what the flight shows as a
whole; land_cover is the dominant cover of the image; leaf_state is what the trees look like.
"""


def parse_answer(text: str, model: str, prompt_version: str = PROMPT_VERSION) -> Call:
	"""The model's JSON reply as a dataset-level model assessment."""
	match = re.search(r'\{.*\}', text or '', re.DOTALL)
	if not match:
		raise AnswerError('No JSON object in the reply')
	try:
		value = json.loads(match.group(0))
	except json.JSONDecodeError as e:
		raise AnswerError(f'Invalid JSON: {e}') from None
	# Any shape the reply can take wrongly (a list for the object, a string for the flags,
	# a list for the verdict) is an AnswerError, so the call is asked once more.
	try:
		verdict = value.get('verdict')
		if verdict not in VERDICTS:
			raise AnswerError(f'Unknown verdict {verdict!r}')
		reason = value.get('reason') or 'none'
		if reason not in MODEL_REASONS + ('none',):
			raise AnswerError(f'Unknown reason {reason!r}')
		likelihood = float(value['exclude_likelihood'])
		flags = {k: float((value.get('flags') or {}).get(k, 0)) for k in FLAGS}
	except AnswerError:
		raise
	except (AttributeError, KeyError, TypeError, ValueError):
		raise AnswerError('The reply does not have the requested fields') from None
	if not all(0 <= v <= 100 for v in (likelihood, *flags.values())):
		raise AnswerError('Likelihoods must be 0-100')
	details = {'reason': None if reason == 'none' else reason}
	for key, allowed in CATEGORIES.items():
		# A category outside the fixed list is kept out rather than failing the call.
		details[key] = value.get(key) if value.get(key) in allowed else None
	details['summary'] = str(value.get('summary') or '')[:500]
	return Call(
		assessor_kind='model',
		model=model,
		prompt_version=prompt_version,
		verdict=VERDICTS[verdict],
		major_likelihood=likelihood,
		modes={k: {'likelihood': v} for k, v in flags.items()},
		details=details,
		raw={'text': text[:20000]},
	)
