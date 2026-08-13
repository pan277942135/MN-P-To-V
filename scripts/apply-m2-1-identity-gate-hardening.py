from pathlib import Path
import re

IDENTITY = Path('src/services/character/identityLockService.ts')
VISUAL = Path('src/services/qa/visualQaService.ts')
ROUTE_TEST = Path('src/__tests__/apiVideoStartRouteIntegration.test.ts')

identity = IDENTITY.read_text()
visual = VISUAL.read_text()
route_test = ROUTE_TEST.read_text()

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

# Route integration: direct image skips rebuild, but must carry a master reference and pass QA before Veo.
route2 = route_test.replace(
    "it('Case 6: DIRECT + imageIsTargetCharacter=true -> rebuild调用0次 -> 允许进入mock Veo submission'",
    "it('Case 6: DIRECT + master QA pass -> rebuild调用0次 -> 允许进入mock Veo submission'",
)
needle = """    const spyPredict = vi.spyOn(VertexClient, 'predictLongRunning').mockResolvedValueOnce({\n      operationName: 'projects/xp-vertex-project/locations/us-central1/operations/op_route_test_6',\n      endpoint: 'us-central1-aiplatform.googleapis.com',\n    });\n\n    const res = await request(app)\n"""
insert = """    const spyPredict = vi.spyOn(VertexClient, 'predictLongRunning').mockResolvedValueOnce({\n      operationName: 'projects/xp-vertex-project/locations/us-central1/operations/op_route_test_6',\n      endpoint: 'us-central1-aiplatform.googleapis.com',\n    });\n\n    const spyQa = vi.spyOn(VisualQaService, 'qaFirstFrame').mockResolvedValueOnce({\n      pass: true,\n      identityScore: 98,\n      sourcePersonResidualScore: 0,\n      scenePreservationScore: 100,\n      posePreservationScore: 100,\n      outfitPreservationScore: 100,\n      anatomyScore: 98,\n      faceDetails: 'Direct image verified against master',\n      hairDetails: 'Direct image hair verified against master',\n      bodyDetails: 'Direct image body preserved',\n      summary: 'Direct target-character image passed mandatory master QA',\n      issues: [],\n    });\n\n    const res = await request(app)\n"""
if needle in route2:
    route2 = route2.replace(needle, insert, 1)
route2 = route2.replace(
    ".attach('firstFrame', createValidPngBuffer(), 'firstFrame.png')\n      .field('rawUserPrompt', 'A target character waving hand')",
    ".attach('firstFrame', createValidPngBuffer(), 'firstFrame.png')\n      .attach('masterImages', createValidPngBuffer(), 'master.png')\n      .field('rawUserPrompt', 'A target character waving hand')",
    1,
)
route2 = route2.replace(
    "    expect(spyRebuild).not.toHaveBeenCalled();\n\n    await vi.waitFor(() => {",
    "    expect(spyRebuild).not.toHaveBeenCalled();\n    expect(spyQa).toHaveBeenCalledTimes(1);\n\n    await vi.waitFor(() => {",
    1,
)

changed = []
if identity2 != identity:
    IDENTITY.write_text(identity2)
    changed.append(str(IDENTITY))
if visual2 != visual:
    VISUAL.write_text(visual2)
    changed.append(str(VISUAL))
if route2 != route_test:
    ROUTE_TEST.write_text(route2)
    changed.append(str(ROUTE_TEST))

if changed:
    print('Applied M2-1 identity gate hardening:', ', '.join(changed))
else:
    print('M2-1 identity gate hardening already applied')
