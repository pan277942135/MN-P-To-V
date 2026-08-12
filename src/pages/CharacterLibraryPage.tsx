import React, { useState, useEffect } from 'react';
import { characterRepository } from '../repositories/characterRepository';
import type { CharacterProfile, AngleTag } from '../types';
import { useConnection } from '../context/ConnectionContext';
import { parseJsonResponse, safeFetchApi } from '../utils/apiClient';
import { getRefImageUrl, safeCreateObjectURL } from '../utils/imageHelper';
import {
  Users,
  Plus,
  Upload,
  CheckCircle2,
  XCircle,
  Sparkles,
  Trash2,
  X,
  RefreshCw,
  Download,
  FileUp,
  Info,
} from 'lucide-react';

export const CharacterLibraryPage: React.FC = () => {
  const { isConnected, autoReconnectFromDb, hasServerSecret } = useConnection();
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedCharacter, setSelectedCharacter] = useState<CharacterProfile | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [masterFiles, setMasterFiles] = useState<Array<{ file: File; angle: AngleTag; previewUrl: string }>>([]);

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadCharacters = async () => {
    const list = await characterRepository.getAll();
    setCharacters(list);
  };

  useEffect(() => {
    loadCharacters();
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    if (masterFiles.length + files.length > 8) {
      setErrorMsg('角色母板照片最多不超过 8 张');
      return;
    }

    const newEntries = files.map((file, idx) => {
      const angle: AngleTag =
        masterFiles.length + idx === 0
          ? 'front'
          : masterFiles.length + idx === 1
          ? 'left_45'
          : masterFiles.length + idx === 2
          ? 'right_45'
          : 'other';

      return {
        file,
        angle,
        previewUrl: safeCreateObjectURL(file as File),
      };
    });

    setMasterFiles((prev) => [...prev, ...newEntries]);
  };

  const removeMasterFile = (index: number) => {
    setMasterFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCreateCharacter = async () => {
    if (!name.trim()) {
      setErrorMsg('请输入角色名称');
      return;
    }
    if (!adultConfirmed || !rightsConfirmed) {
      setErrorMsg('必须确认该角色为成年人物，且拥有使用权');
      return;
    }
    if (masterFiles.length < 3 || masterFiles.length > 8) {
      setErrorMsg('必须上传 3～8 张角色多角度母板照片');
      return;
    }

    let storedConnectionId = localStorage.getItem('zaojing_connection_id');
    if (!storedConnectionId) {
      await autoReconnectFromDb();
      storedConnectionId = localStorage.getItem('zaojing_connection_id');
    }

    if (!storedConnectionId && !hasServerSecret) {
      setErrorMsg('请先在「算力设置」中连接 Google 算力通道');
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      const formData = new FormData();
      formData.append('name', name.trim());
      formData.append('description', description.trim());
      formData.append('adultConfirmed', 'true');
      formData.append('rightsConfirmed', 'true');

      masterFiles.forEach((m) => {
        formData.append('masterPhotos', m.file);
      });

      const { res, data } = await safeFetchApi('/api/characters/analyze', {
        method: 'POST',
        headers: storedConnectionId ? { 'x-connection-id': storedConnectionId } : {},
        body: formData,
      });

      if (!res.ok) {
        throw new Error(data.error || '分析角色身份失败');
      }

      const returnedConnId = res.headers.get('x-connection-id');
      if (returnedConnId) {
        localStorage.setItem('zaojing_connection_id', returnedConnId);
      }

      const references = Array.isArray(data.references) ? data.references : [];
      const identitySpec = data.identitySpec || {
        lockedTraits: [],
        adultStatus: 'confirmed_adult',
        identityLockPromptEnglish: description.trim(),
        identityLockPromptChinese: description.trim(),
      };

      // Convert Blobs for Dexie storage
      const charId = data.characterId || data.id || `char_${crypto.randomUUID()}`;
      const newChar: CharacterProfile = {
        id: charId,
        name: name.trim(),
        description: description.trim(),
        adultConfirmed: true,
        rightsConfirmed: true,
        status: data.status || 'ready',
        identitySpec,
        referenceImages: (references.length > 0 ? references : masterFiles).map((r: any, idx: number) => {
          const fileObj = masterFiles[idx]?.file;
          const thumbUrl = r.thumbnailUrl || r.url || masterFiles[idx]?.previewUrl;
          return {
            id: r.id || `ref_${idx}`,
            blob: fileObj ? new Blob([fileObj], { type: fileObj.type }) : undefined,
            originalBlob: fileObj ? new Blob([fileObj], { type: fileObj.type }) : undefined,
            thumbnailUrl: thumbUrl,
            dataUrl: thumbUrl,
            mimeType: r.mimeType || fileObj?.type || 'image/jpeg',
            width: r.width || 1080,
            height: r.height || 1080,
            angle: r.angle || (idx === 0 ? 'front' : 'other'),
            qualityScore: r.qualityScore || 90,
            qualityIssues: r.qualityIssues || [],
            sortOrder: idx,
          };
        }),
        selectedImageReferenceIds: data.selectedImageReferenceIds || [],
        selectedVideoReferenceIds: data.selectedVideoReferenceIds || [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        analysisError: data.analysisError,
      };

      await characterRepository.save(newChar);
      localStorage.setItem('zaojing_option_selectedCharacterId', newChar.id);
      await loadCharacters();

      setShowCreateModal(false);
      setName('');
      setDescription('');
      setAdultConfirmed(false);
      setRightsConfirmed(false);
      setMasterFiles([]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCharacter = async (id: string) => {
    if (confirm('确认删除此虚拟角色包？')) {
      await characterRepository.delete(id);
      if (selectedCharacter?.id === id) {
        setSelectedCharacter(null);
      }
      await loadCharacters();
    }
  };

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-6 sm:space-y-8">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-zinc-100 flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-400" />
            角色库与身份锁定
          </h2>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            建立固定虚拟角色档案，通过 3～8 张母板图锁定五官、发型与身材解剖结构。
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs sm:text-sm transition flex items-center gap-2 shrink-0"
        >
          <Plus className="w-4 h-4" />
          新建虚拟角色
        </button>
      </div>

      {/* Characters List */}
      {characters.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 sm:p-12 text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center mx-auto text-zinc-400">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-zinc-200">角色库为空</h3>
            <p className="text-xs text-zinc-500 mt-1">
              请新建角色，上传 3~8 张多角度母板照片提炼身份控制包。
            </p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            立即建立首个角色
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {characters.map((char) => (
            <div
              key={char.id}
              onClick={() => setSelectedCharacter(char)}
              className="bg-zinc-900 border border-zinc-800 hover:border-indigo-500/50 rounded-xl p-4 cursor-pointer transition space-y-4 group"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-base font-bold text-zinc-100 group-hover:text-indigo-400 transition">
                    {char.name}
                  </h3>
                  <p className="text-xs text-zinc-400 line-clamp-1 mt-0.5">{char.description || '无描述'}</p>
                </div>

                <span
                  className={`text-xs px-2 py-0.5 rounded font-medium ${
                    char.status === 'ready'
                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/50'
                      : 'bg-rose-950 text-rose-400 border border-rose-800/50'
                  }`}
                >
                  {char.status === 'ready' ? '身份锁已就绪' : '解析异常'}
                </span>
              </div>

              {/* Master Images Grid Preview */}
              <div className="grid grid-cols-4 gap-1.5 rounded-lg overflow-hidden bg-zinc-950 p-1">
                {(char.referenceImages || []).map((ref, idx) => {
                  const url = getRefImageUrl(ref);
                  if (!url) return null;
                  return (
                    <div key={ref.id || idx} className="aspect-square bg-zinc-800 rounded overflow-hidden">
                      <img
                        src={url}
                        alt={`ref_${idx}`}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  );
                })}
              </div>

              {/* Specs badges */}
              {char.identitySpec?.lockedTraits && char.identitySpec.lockedTraits.length > 0 && (
                <div className="flex flex-wrap gap-1 text-[11px]">
                  {char.identitySpec.lockedTraits.slice(0, 3).map((t, idx) => (
                    <span key={idx} className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                      {t.traitName}: {t.expectedValue}
                    </span>
                  ))}
                </div>
              )}

              <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between text-xs text-zinc-500">
                <span>更新于 {new Date(char.updatedAt).toLocaleDateString()}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteCharacter(char.id);
                  }}
                  className="hover:text-rose-400 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Character Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between sticky top-0 bg-zinc-900 z-10">
              <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
                <Users className="w-4 h-4 text-indigo-400" />
                建立虚拟角色包
              </h3>
              <button onClick={() => setShowCreateModal(false)} className="text-zinc-400 hover:text-zinc-200">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-6 text-sm">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block font-medium text-zinc-300 mb-1">角色名称 *</label>
                  <input
                    type="text"
                    placeholder="例如: 楚瑶 (艾丽斯)"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block font-medium text-zinc-300 mb-1">角色简介描述</label>
                  <input
                    type="text"
                    placeholder="例如: 26岁都市女性，黑发微卷，眼神从容"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Confirmations */}
              <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 space-y-2">
                <label className="flex items-center space-x-2 text-xs text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={adultConfirmed}
                    onChange={(e) => setAdultConfirmed(e.target.checked)}
                    className="rounded bg-zinc-800 border-zinc-700 text-indigo-600 focus:ring-0"
                  />
                  <span>确认该角色为成年虚拟人物 (Adult Virtual Character)</span>
                </label>

                <label className="flex items-center space-x-2 text-xs text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rightsConfirmed}
                    onChange={(e) => setRightsConfirmed(e.target.checked)}
                    className="rounded bg-zinc-800 border-zinc-700 text-indigo-600 focus:ring-0"
                  />
                  <span>确认拥有上传母板图片素材的合法合法使用权</span>
                </label>
              </div>

              {/* Photos upload */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="font-medium text-zinc-300">角色多角度母板照片 (3～8 张) *</label>
                  <span className="text-xs text-zinc-500">建议包含正面、左右45度、全身照</span>
                </div>

                <div className="grid grid-cols-4 gap-3">
                  {masterFiles.map((item, idx) => (
                    <div key={idx} className="relative group aspect-square rounded-lg bg-zinc-950 border border-zinc-800 overflow-hidden">
                      <img src={item.previewUrl} alt="master" className="w-full h-full object-cover" />
                      <button
                        onClick={() => removeMasterFile(idx)}
                        className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition"
                      >
                        <X className="w-3 h-3" />
                      </button>
                      <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-zinc-300">
                        {item.angle}
                      </span>
                    </div>
                  ))}

                  {masterFiles.length < 8 && (
                    <label className="aspect-square rounded-lg bg-zinc-950 border border-dashed border-zinc-800 hover:border-indigo-500/50 flex flex-col items-center justify-center cursor-pointer transition text-zinc-500 hover:text-indigo-400">
                      <Upload className="w-5 h-5 mb-1" />
                      <span className="text-xs">添加照片</span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple
                        onChange={handleFileSelect}
                        className="hidden"
                      />
                    </label>
                  )}
                </div>
              </div>

              {errorMsg && (
                <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-800/60 text-rose-300 text-xs">
                  {errorMsg}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-zinc-800 flex items-center justify-end space-x-3 bg-zinc-900 sticky bottom-0">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 rounded-lg text-zinc-400 hover:text-zinc-200 text-sm font-medium transition"
              >
                取消
              </button>

              <button
                onClick={handleCreateCharacter}
                disabled={loading}
                className="px-6 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 text-white font-medium text-sm transition flex items-center gap-2"
              >
                {loading && <RefreshCw className="w-4 h-4 animate-spin" />}
                立项并分析身份锁
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Character Detail Drawer */}
      {selectedCharacter && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end">
          <div className="bg-zinc-900 border-l border-zinc-800 w-full max-w-lg h-full overflow-y-auto p-6 space-y-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
              <h3 className="text-lg font-bold text-zinc-100">{selectedCharacter.name}</h3>
              <button onClick={() => setSelectedCharacter(null)} className="text-zinc-400 hover:text-zinc-200">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Master photos gallery preview */}
            {selectedCharacter.referenceImages && selectedCharacter.referenceImages.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-zinc-300">角色母板照片库 ({selectedCharacter.referenceImages.length} 张)</div>
                <div className="grid grid-cols-4 gap-2">
                  {selectedCharacter.referenceImages.map((ref, idx) => {
                    const url = getRefImageUrl(ref);
                    if (!url) return null;
                    return (
                      <div key={ref.id || idx} className="aspect-square bg-zinc-950 rounded-lg overflow-hidden border border-zinc-800 relative group">
                        <img src={url} alt={`ref_${idx}`} className="w-full h-full object-cover" />
                        <span className="absolute bottom-1 left-1 px-1 py-0.5 rounded bg-black/70 text-[9px] text-zinc-300">
                          {ref.angle || `照片${idx + 1}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {selectedCharacter.identitySpec ? (
              <div className="space-y-4 text-xs">
                <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1">
                  <div className="font-semibold text-zinc-300">角色描述原文</div>
                  <div className="text-zinc-200 leading-relaxed">
                    "{selectedCharacter.description || '无描述'}"
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1">
                  <div className="font-semibold text-zinc-300">锁定 Prompt (英文)</div>
                  <div className="font-mono text-zinc-400 text-[11px] leading-relaxed">
                    {selectedCharacter.identitySpec.identityLockPromptEnglish}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="font-semibold text-zinc-300">锁定身份特征 (Locked Traits)</div>
                  {(selectedCharacter.identitySpec.lockedTraits || []).length === 0 ? (
                    <p className="text-zinc-500 italic">用户描述原文未提及具体锁定特征</p>
                  ) : (
                    <div className="space-y-2">
                      {(selectedCharacter.identitySpec.lockedTraits || []).map((trait, idx) => (
                        <div key={idx} className="p-2.5 bg-zinc-950 rounded border border-zinc-800 space-y-1">
                          <div className="flex items-center justify-between font-medium">
                            <span className="text-indigo-400">{trait.traitName}</span>
                            <span className="text-zinc-200">{trait.expectedValue}</span>
                          </div>
                          {trait.sourceText && (
                            <div className="text-[11px] text-zinc-500">原文词段: "{trait.sourceText}"</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-rose-400">{selectedCharacter.analysisError}</p>
            )}

            <div className="pt-4 border-t border-zinc-800 flex justify-end">
              <button
                onClick={() => handleDeleteCharacter(selectedCharacter.id)}
                className="px-4 py-2 rounded bg-rose-950 text-rose-400 hover:bg-rose-900 text-xs font-medium"
              >
                删除角色档案
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
