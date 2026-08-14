from pathlib import Path

path = Path('src/services/video/videoGenerator.ts')
text = path.read_text()

old_base64 = """    const isBase64Str = (str: string) => {\n      if (typeof str !== 'string') return false;\n      const trimmed = str.trim();\n      return (\n        trimmed.length >= 10 &&\n        !trimmed.includes(' ') &&\n        !trimmed.startsWith('http') &&\n        !trimmed.startsWith('gs://') &&\n        !trimmed.startsWith('projects/') &&\n        !trimmed.startsWith('files/')\n      );\n    };\n"""

new_base64 = """    const isExplicitVideoBytesStr = (str: string) => {\n      if (typeof str !== 'string') return false;\n      const trimmed = str.trim();\n      // Only call this predicate for named video-byte fields. Keep malformed/short\n      // explicit byte payloads visible so pollVeoOperation can classify them as\n      // artifact_invalid rather than upstream_empty_response.\n      return trimmed.length > 0 && !isUriStr(trimmed);\n    };\n"""

if old_base64 not in text:
    raise SystemExit('base64 parser contract block not found; refusing unsafe patch')
text = text.replace(old_base64, new_base64, 1)

# Named byte fields remain extractable, including malformed test payloads, so the
# downstream MP4 validity gate preserves artifact_invalid semantics.
text = text.replace('typeof b64 === \'string\' && isBase64Str(b64)', "typeof b64 === 'string' && isExplicitVideoBytesStr(b64)")

# Arbitrary strings encountered while recursively walking protobuf metadata must
# never be guessed as base64. This is the exact production bug: Vertex Veo's
# @type marker decodes to 48 bytes in Node and preempted the real videos[].gcsUri.
old_walk_string = """      if (typeof node === 'string') {\n        if (!foundUri && isUriStr(node)) {\n          foundUri = node.trim();\n        } else if (!foundBase64 && isBase64Str(node)) {\n          foundBase64 = node.trim();\n        }\n        return;\n      }\n"""
new_walk_string = """      if (typeof node === 'string') {\n        if (!foundUri && isUriStr(node)) {\n          foundUri = node.trim();\n        }\n        return;\n      }\n"""
if old_walk_string not in text:
    raise SystemExit('recursive string parser block not found; refusing unsafe patch')
text = text.replace(old_walk_string, new_walk_string, 1)

unsafe_zero_count_markers = """      str.includes('raiMediaFiltered') ||\n      str.includes('rai_media_filtered') ||\n"""
safety_comment_anchor = """    const hasSafetyKeyword =\n      str.includes('RAI_MEDIA_FILTERED') ||\n"""
safety_comment_replacement = """    const hasSafetyKeyword =\n      // Field names such as raiMediaFilteredCount are present even on successful\n      // responses with value 0. Only positive counts/reasons (handled above) or\n      // explicit safety values should mark the response as filtered.\n      str.includes('RAI_MEDIA_FILTERED') ||\n"""

if unsafe_zero_count_markers not in text:
    raise SystemExit('zero-count safety markers not found; refusing unsafe patch')
if safety_comment_anchor not in text:
    raise SystemExit('safety keyword anchor not found; refusing unsafe patch')
text = text.replace(unsafe_zero_count_markers, '', 1)
text = text.replace(safety_comment_anchor, safety_comment_replacement, 1)

path.write_text(text)
print('Applied Veo 48-byte parser hardening with explicit-byte-field semantics')
