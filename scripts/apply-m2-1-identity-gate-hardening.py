from pathlib import Path
import re

IDENTITY = Path('src/services/character/identityLockService.ts')
VISUAL = Path('src/services/qa/visualQaService.ts')

identity = IDENTITY.read_text()
visual = VISUAL.read_text()

# DIRECT_CHARACTER_IMAGE only skips rebuild. It must never bypass identity QA.
pattern = re.compile(
    r"\n    const isDirectUserConfirmed = input\.imageIsTargetCharacter === true;\n\n"
    r"    if \(isDirectUserConfirmed\) \{.*?\n"
    r"    \} else if \(input\.ai && input\.masterImageBuffer && input\.masterImageBuffer\.length > 0\) \{",
    re.S,
)
replacement = "\n\n    if (input.ai && input.masterImageBuffer && input.masterImageBuffer.length > 0) {"
identity2, count = pattern.subn(replacement, identity, count=1)
if count != 1 and 'isDirectUserConfirmed' in identity:
    raise SystemExit('failed to remove direct-image QA bypass')

identity2 = identity2.replace(
    "   * DIRECT_CHARACTER_IMAGE:\n   *   -> Bypasses image-to-image rebuild\n   *   -> Picture is set directly as Approved First Frame",
    "   * DIRECT_CHARACTER_IMAGE:\n   *   -> Bypasses image-to-image rebuild only\n   *   -> Picture is set directly as the candidate first frame\n   *   -> Identity QA against the character master still remains mandatory",
)

# Visual QA must not auto-score animate_existing_character as a perfect 100.
visual_pattern = re.compile(
    r"\n    if \(sceneMode === 'animate_existing_character'\) \{.*?\n"
    r"    \}\n\n    const promptText = `",
    re.S,
)
visual2, count = visual_pattern.subn("\n    const promptText = `", visual, count=1)
if count != 1 and "summary: '已直通：首帧直接使用上传场景图，免重绘与质检'" in visual:
    raise SystemExit('failed to remove animate_existing_character QA bypass')

visual2 = visual2.replace(
    "- sourcePersonResidualScore: 是否残存原场景图人物的脸部特征。合格线 <= 5 (在 replace_primary_person 模式下必须彻底替换)。",
    "- sourcePersonResidualScore: 仅用于 replace_primary_person，判断是否残存原场景人物脸部特征，合格线 <= 5。对于 animate_existing_character，原场景人物本身就是目标角色，此项不参与 Gate，请返回 0。",
)
visual2 = visual2.replace(
    "      const pass =\n        identityScore >= 95 &&\n        residualScore <= 5 &&",
    "      const residualPass = sceneMode === 'replace_primary_person' ? residualScore <= 5 : true;\n\n      const pass =\n        identityScore >= 95 &&\n        residualPass &&",
)

if identity2 == identity and visual2 == visual:
    print('M2-1 identity gate hardening already applied')
else:
    IDENTITY.write_text(identity2)
    VISUAL.write_text(visual2)
    print('Applied M2-1 identity gate hardening')
