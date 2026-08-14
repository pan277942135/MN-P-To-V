from pathlib import Path

path = Path('src/services/video/videoGenerator.ts')
text = path.read_text()

old_base64 = """    const isBase64Str = (str: string) => {\n      if (typeof str !== 'string') return false;\n      const trimmed = str.trim();\n      return (\n        trimmed.length >= 10 &&\n        !trimmed.includes(' ') &&\n        !trimmed.startsWith('http') &&\n        !trimmed.startsWith('gs://') &&\n        !trimmed.startsWith('projects/') &&\n        !trimmed.startsWith('files/')\n      );\n    };\n"""

new_base64 = """    const isBase64Str = (str: string) => {\n      if (typeof str !== 'string') return false;\n      const trimmed = str.trim();\n\n      // A video payload must look like actual base64 *and* decode to a valid MP4.\n      // Do not classify arbitrary metadata strings (notably Vertex Veo's @type\n      // marker) as video bytes. The @type marker decodes to exactly 48 bytes in\n      // Node and caused the production/UAT sizeBytes=48 false-artifact failure.\n      if (\n        trimmed.length < 1024 ||\n        /\\s/.test(trimmed) ||\n        !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)\n      ) {\n        return false;\n      }\n\n      try {\n        const decoded = Buffer.from(trimmed, 'base64');\n        return VideoGenerator.isMp4Valid(decoded);\n      } catch {\n        return false;\n      }\n    };\n"""

unsafe_zero_count_markers = """      str.includes('raiMediaFiltered') ||\n      str.includes('rai_media_filtered') ||\n"""

safety_comment_anchor = """    const hasSafetyKeyword =\n      str.includes('RAI_MEDIA_FILTERED') ||\n"""

safety_comment_replacement = """    const hasSafetyKeyword =\n      // Field names such as raiMediaFilteredCount are present even on successful\n      // responses with value 0. Only positive counts/reasons (handled above) or\n      // explicit safety values should mark the response as filtered.\n      str.includes('RAI_MEDIA_FILTERED') ||\n"""

if old_base64 not in text:
    raise SystemExit('base64 parser contract block not found; refusing unsafe patch')
if unsafe_zero_count_markers not in text:
    raise SystemExit('zero-count safety markers not found; refusing unsafe patch')
if safety_comment_anchor not in text:
    raise SystemExit('safety keyword anchor not found; refusing unsafe patch')

text = text.replace(old_base64, new_base64, 1)
text = text.replace(unsafe_zero_count_markers, '', 1)
text = text.replace(safety_comment_anchor, safety_comment_replacement, 1)
path.write_text(text)
print('Applied Veo 48-byte parser hardening')
