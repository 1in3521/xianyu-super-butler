import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AccountDeliveryPool, Card } from '../types';
import { getAccountDeliveryPools, getCards, createCard, updateCard, deleteCard } from '../services/api';
import { confirmAction, notify } from '../services/feedback';
import { Plus, CreditCard, FileText, Image as ImageIcon, Code, Edit, Trash2, Save, X, Package, Boxes, Copy } from 'lucide-react';
import { EmptyState, PageHeader, SectionHeader } from './ui';
import { buildAccountDeliveryConfig, displayDuration, isInternalAccountDeliveryCard, parseDuration, readAccountDeliveryCard, type DurationUnit } from '../lib/accountDeliveryCard';

type CardEditForm = Partial<Card> & {
  api_url?: string;
  api_method?: 'GET' | 'POST';
  api_timeout?: number;
  api_headers?: string;
  api_params?: string;
};

type AddCardForm = {
  name: string;
  type: Card['type'];
  content: string;
  description: string;
  enabled: boolean;
  delay_seconds: number;
  api_mode: 'managed' | 'custom';
  source_card_id: number | null;
  pool_id: string;
  duration_amount: string;
  duration_unit: DurationUnit;
};

const emptyAddForm: AddCardForm = {
  name: '',
  type: 'text',
  content: '',
  description: '',
  enabled: true,
  delay_seconds: 0,
  api_mode: 'custom',
  source_card_id: null,
  pool_id: '',
  duration_amount: '2',
  duration_unit: 'hours',
};

const jsonText = (value: unknown): string =>
  typeof value === 'string' ? value : value ? JSON.stringify(value, null, 2) : '';

const validJsonObject = (value: string, label: string): boolean => {
  if (!value.trim()) return true;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return true;
  } catch {
    // The message below is shared by malformed JSON and non-object JSON.
  }
  notify(`${label}必须是 JSON 对象，例如 {"key":"value"}`);
  return false;
};

const poolLoadMessage = (error: unknown): string => {
  const message = (error as { response?: { data?: { message?: unknown } }; message?: unknown })
    ?.response?.data?.message;
  if (typeof message === 'string' && message.trim()) return message;
  return error instanceof Error && error.message.startsWith('账号池列表格式异常')
    ? error.message
    : '无法读取账号系统的账号池，请检查连接后重试';
};

const DurationFields: React.FC<{
  amount: string;
  unit: DurationUnit;
  onAmountChange: (value: string) => void;
  onUnitChange: (value: DurationUnit) => void;
}> = ({ amount, unit, onAmountChange, onUnitChange }) => (
  <div>
    <label className="mb-2 block text-sm font-bold text-gray-700">提取账号后的有效时长 <span className="text-red-500">*</span></label>
    <div className="grid grid-cols-[1fr_120px] gap-2">
      <input
        type="number"
        min="1"
        step="1"
        value={amount}
        onChange={(event) => onAmountChange(event.target.value)}
        className="ios-input w-full rounded-md px-3 py-2.5"
        aria-label="提取码有效时长"
      />
      <select
        value={unit}
        onChange={(event) => onUnitChange(event.target.value as DurationUnit)}
        className="ios-input rounded-md px-3 py-2.5"
        aria-label="有效时长单位"
      >
        <option value="minutes">分钟</option>
        <option value="hours">小时</option>
        <option value="days">天</option>
      </select>
    </div>
    <p className="mt-2 text-xs text-gray-500">例如填 2 小时，买家首次提取账号后可使用 2 小时；购买多份会按份数分别发码。</p>
  </div>
);

const AccountPoolFields: React.FC<{
  selectedId: string;
  pools: AccountDeliveryPool[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string;
  onChange: (id: string) => void;
  onRetry: () => void;
}> = ({ selectedId, pools, status, error, onChange, onRetry }) => {
  const selectedMissing = selectedId && !pools.some(pool => pool.id === selectedId);
  return (
    <div>
      <label className="mb-2 block text-sm font-bold text-gray-700" htmlFor="account-delivery-pool">
        选择账号系统中的账号池 <span className="text-red-500">*</span>
      </label>
      <select
        id="account-delivery-pool"
        value={selectedId}
        disabled={status !== 'ready' || pools.length === 0}
        onChange={(event) => onChange(event.target.value)}
        className="ios-input w-full rounded-md px-3 py-2.5 disabled:opacity-60"
      >
        <option value="">请选择账号池</option>
        {selectedMissing && (
          <option value={selectedId} disabled>
            {status === 'ready' ? '原账号池已不存在' : '正在核对原账号池'}（{selectedId}）
          </option>
        )}
        {pools.map(pool => <option key={pool.id} value={pool.id}>{pool.name}</option>)}
      </select>
      {status === 'loading' && <p className="mt-2 text-xs text-gray-500">正在读取账号系统中的账号池…</p>}
      {status === 'error' && (
        <div className="mt-2 text-xs text-red-700" role="alert">
          {error}
          <button type="button" className="ml-2 font-semibold underline" onClick={onRetry}>重试</button>
        </div>
      )}
      {status === 'ready' && pools.length === 0 && (
        <p className="mt-2 text-xs text-red-700" role="alert">账号系统中暂无账号池，请先创建账号池。</p>
      )}
      {status === 'ready' && selectedMissing && (
        <p className="mt-2 text-xs text-red-700" role="alert">原账号池已不在账号系统中，请选择一个现有账号池后保存。</p>
      )}
      {status === 'ready' && pools.length > 0 && !selectedMissing && (
        <p className="mt-2 text-xs text-gray-500">保存后，机器人会从所选账号池为订单生成提取码。</p>
      )}
    </div>
  );
};

const CardList: React.FC = () => {
  const [cards, setCards] = useState<Card[]>([]);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [editForm, setEditForm] = useState<CardEditForm>({});
  const [editApiMode, setEditApiMode] = useState<'managed' | 'custom'>('custom');
  const [editPoolId, setEditPoolId] = useState('');
  const [editDurationAmount, setEditDurationAmount] = useState('2');
  const [editDurationUnit, setEditDurationUnit] = useState<DurationUnit>('hours');
  const [addForm, setAddForm] = useState<AddCardForm>(emptyAddForm);
  const [pools, setPools] = useState<AccountDeliveryPool[]>([]);
  const [poolStatus, setPoolStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [poolError, setPoolError] = useState('');
  const [poolRefresh, setPoolRefresh] = useState(0);

  const managedCards = cards.filter(card => readAccountDeliveryCard(card) !== null);
  const connectionCards = managedCards.filter(isInternalAccountDeliveryCard);

  const openAddModal = (template?: Card) => {
    const source = template && isInternalAccountDeliveryCard(template) ? template : connectionCards[0];
    const managed = template && readAccountDeliveryCard(template);
    const duration = managed && displayDuration(managed.durationMinutes);
    setAddForm({
      ...emptyAddForm,
      name: template ? `${template.name} 副本` : '',
      type: template ? 'api' : 'text',
      api_mode: source ? 'managed' : 'custom',
      source_card_id: source?.id ?? null,
      pool_id: managed?.poolId ?? '',
      duration_amount: duration?.amount ?? '2',
      duration_unit: duration?.unit ?? 'hours',
      description: template?.description || '',
      delay_seconds: template?.delay_seconds || 0,
    });
    setShowAddModal(true);
  };

  useEffect(() => {
    getCards().then(setCards);
  }, []);

  useEffect(() => {
    const needsPools =
      (showAddModal && addForm.type === 'api' && addForm.api_mode === 'managed') ||
      (showEditModal && editApiMode === 'managed');
    if (!needsPools) return;
    let active = true;
    setPoolStatus('loading');
    setPoolError('');
    setPools([]);
    getAccountDeliveryPools()
      .then((result) => {
        if (!active) return;
        setPools(result);
        setPoolStatus('ready');
      })
      .catch((error) => {
        if (!active) return;
        setPoolError(poolLoadMessage(error));
        setPoolStatus('error');
      });
    return () => { active = false; };
  }, [showAddModal, addForm.type, addForm.api_mode, showEditModal, editApiMode, poolRefresh]);

  const CardIcon = ({ type }: { type: string }) => {
      switch(type) {
          case 'text': return <FileText className="w-5 h-5 text-blue-500" />;
          case 'image': return <ImageIcon className="w-5 h-5 text-purple-500" />;
          case 'api': return <Code className="w-5 h-5 text-orange-500" />;
          default: return <CreditCard className="w-5 h-5 text-gray-500" />;
      }
  };

  const handleEdit = (card: Card) => {
    const managed = readAccountDeliveryCard(card);
    const duration = managed && displayDuration(managed.durationMinutes);
    setSelectedCard(card);
    setEditApiMode(managed ? 'managed' : 'custom');
    setEditPoolId(managed?.poolId || '');
    setEditDurationAmount(duration?.amount || '2');
    setEditDurationUnit(duration?.unit || 'hours');
    setEditForm({
      id: card.id,
      name: card.name || '',
      type: card.type || 'text',
      // API 配置
      api_url: card.api_config?.url || '',
      api_method: card.api_config?.method || 'GET',
      api_timeout: card.api_config?.timeout || 10,
      api_headers: jsonText(card.api_config?.headers),
      api_params: jsonText(card.api_config?.params),
      // 文本配置
      text_content: card.text_content || '',
      // 批量数据配置
      data_content: card.data_content || '',
      // 图片配置
      image_url: card.image_url || '',
      // 通用配置
      delay_seconds: card.delay_seconds || 0,
      description: card.description || '',
      enabled: card.enabled
    });
    setShowEditModal(true);
  };

  const handleSaveEdit = async () => {
    if (!selectedCard) return;

    // 验证必填字段
    if (!editForm.name?.trim()) {
      notify('请输入卡密名称');
      return;
    }
    if (!editForm.type) {
      notify('请选择卡密类型');
      return;
    }

    try {
      const updateData: Partial<Card> = {
        name: editForm.name.trim(),
        type: editForm.type as any,
        description: editForm.description?.trim(),
        delay_seconds: editForm.delay_seconds || 0,
        enabled: editForm.enabled ?? true
      };

      // 根据类型设置内容
      if (editForm.type === 'api') {
        if (editApiMode === 'managed') {
          const minutes = parseDuration(editDurationAmount, editDurationUnit);
          if (minutes === null) {
            notify('请输入有效时长，范围为 1 分钟到 365 天');
            return;
          }
          const original = readAccountDeliveryCard(selectedCard);
          if (!original) {
            notify('这张卡密不是账号系统提取码，请使用高级配置');
            return;
          }
          if (poolStatus !== 'ready' || !pools.some(pool => pool.id === editPoolId)) {
            notify('请先读取并选择账号系统中现有的账号池');
            return;
          }
          if ((original.poolId !== editPoolId || original.durationMinutes !== minutes) && !(await confirmAction(
            '修改已有卡密的账号池或有效时长，可能使旧订单重试返回冲突。建议新增卡密并绑定新商品。仍要修改吗？'
          ))) return;
          updateData.api_config = buildAccountDeliveryConfig(selectedCard, editPoolId, minutes);
        } else {
          if (!editForm.api_url?.trim()) {
            notify('请输入 API 地址');
            return;
          }
          if (!validJsonObject(editForm.api_headers || '', '请求头') ||
              !validJsonObject(editForm.api_params || '', '请求参数')) return;
          updateData.api_config = {
            url: editForm.api_url.trim(),
            method: editForm.api_method || 'GET',
            timeout: editForm.api_timeout || 10,
            headers: editForm.api_headers?.trim() || undefined,
            params: editForm.api_params?.trim() || undefined
          };
        }
      } else if (editForm.type === 'text') {
        updateData.text_content = editForm.text_content?.trim() || '';
      } else if (editForm.type === 'data') {
        updateData.data_content = editForm.data_content?.trim() || '';
      } else if (editForm.type === 'image') {
        updateData.image_url = editForm.image_url?.trim() || '';
      }

      await updateCard(selectedCard.id, updateData);
      setShowEditModal(false);
      getCards().then(setCards);
    } catch (error) {
      console.error('更新卡密失败:', error);
      notify('更新失败，请重试');
    }
  };

  const handleDelete = async (id: string) => {
    if (await confirmAction('确认删除该卡密吗？')) {
      try {
        await deleteCard(id);
        getCards().then(setCards);
      } catch (error) {
        console.error('删除卡密失败:', error);
        notify('删除失败，请重试');
      }
    }
  };

  const handleAddCard = async () => {
    const name = addForm.name.trim();
    const content = addForm.content.trim();
    if (!name) {
      notify('请输入卡密名称');
      return;
    }
    if (!(addForm.type === 'api' && addForm.api_mode === 'managed') && !content) {
      notify(addForm.type === 'api' ? '请输入 API 地址' : '请输入卡密内容');
      return;
    }

    try {
      const createData: Partial<Card> = {
        name,
        type: addForm.type,
        description: addForm.description.trim(),
        enabled: addForm.enabled,
        delay_seconds: addForm.delay_seconds
      };

      if (addForm.type === 'text') {
        createData.text_content = content;
      } else if (addForm.type === 'data') {
        createData.data_content = content;
      } else if (addForm.type === 'image') {
        createData.image_url = content;
      } else if (addForm.api_mode === 'managed') {
        const template = connectionCards.find(card => card.id === addForm.source_card_id);
        const minutes = parseDuration(addForm.duration_amount, addForm.duration_unit);
        if (!template) {
          notify('服务器内网取码连接尚未配置，请先由管理员完成首次接入');
          return;
        }
        if (poolStatus !== 'ready' || !pools.some(pool => pool.id === addForm.pool_id)) {
          notify('请先读取并选择账号系统中现有的账号池');
          return;
        }
        if (minutes === null) {
          notify('请输入有效时长，范围为 1 分钟到 365 天');
          return;
        }
        createData.api_config = buildAccountDeliveryConfig(template, addForm.pool_id, minutes);
        createData.delivery_template = template.delivery_template;
        createData.delivery_template_enabled = template.delivery_template_enabled;
        createData.delivery_template_images = template.delivery_template_images;
      } else {
        createData.api_config = { url: content, method: 'GET', timeout: 10 };
      }

      await createCard(createData);
      setShowAddModal(false);
      setAddForm(emptyAddForm);
      getCards().then(setCards);
    } catch (error) {
      console.error('添加卡密失败:', error);
      notify('添加失败，请重试');
    }
  };

  const toggleCardStatus = async (card: Card) => {
    try {
      await updateCard(card.id, { ...card, enabled: !card.enabled });
      getCards().then(setCards);
    } catch (error) {
      console.error('切换状态失败:', error);
    }
  };

  const enabledCount = cards.filter(card => card.enabled).length;
  const batchInventory = cards.reduce((total, card) => {
    if (card.type !== 'data' || !card.data_content) return total;
    return total + card.data_content.split('\n').filter(line => line.trim()).length;
  }, 0);

  return (
    <div className="page-stack animate-fade-in">
      <PageHeader
        title="卡密库存"
        description="集中维护自动发货所需的固定文本、批量卡密、图片和 API 数据源。"
        icon={CreditCard}
        actions={(
          <button
            onClick={() => openAddModal()}
            className="ios-btn-primary flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm"
          >
            <Plus className="h-4 w-4" />
            添加卡密
          </button>
        )}
      />

      <div className="metric-grid">
        <div className="metric-card">
          <p className="metric-card__label">卡密组</p>
          <p className="metric-card__value">{cards.length}</p>
          <p className="metric-card__meta">所有已配置的数据源</p>
        </div>
        <div className="metric-card">
          <p className="metric-card__label">启用中</p>
          <p className="metric-card__value">{enabledCount}</p>
          <p className="metric-card__meta">{cards.length - enabledCount} 组已停用</p>
        </div>
        <div className="metric-card">
          <p className="metric-card__label">批量库存</p>
          <p className="metric-card__value">{batchInventory}</p>
          <p className="metric-card__meta">按有效非空行统计</p>
        </div>
      </div>

      <section className="section-panel">
        <SectionHeader
          title="库存数据源"
          description="停用后不会被自动发货规则调用，已有内容仍会保留。"
          icon={Boxes}
        />
        <div className="overflow-x-auto">
          <table className="data-table responsive-data-table min-w-[860px]">
            <thead>
              <tr>
                <th className="w-[22%]">卡密名称</th>
                <th className="w-[11%]">类型</th>
                <th className="w-[25%]">内容 / 库存</th>
                <th className="w-[22%]">说明</th>
                <th className="w-[10%]">状态</th>
                <th className="w-[10%] text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => {
                // 计算库存或内容预览
                let stockInfo = '';
                if (card.type === 'data' && card.data_content) {
                  const lines = card.data_content.split('\n').filter(line => line.trim());
                  stockInfo = `库存: ${lines.length} 条`;
                } else if (card.type === 'text' && card.text_content) {
                  stockInfo = card.text_content.substring(0, 20) + (card.text_content.length > 20 ? '...' : '');
                } else if (card.type === 'api' && card.api_config) {
                  const managed = readAccountDeliveryCard(card);
                  if (managed) {
                    const duration = displayDuration(managed.durationMinutes);
                    const unitLabel = { minutes: '分钟', hours: '小时', days: '天' }[duration.unit];
                    stockInfo = `账号系统提取码 · ${duration.amount} ${unitLabel}`;
                  } else {
                    stockInfo = '自定义 API';
                  }
                } else if (card.type === 'image' && card.image_url) {
                  stockInfo = '图片链接';
                }

                return (
                  <tr key={card.id} className="group">
                    <td data-label="卡密名称">
                      <div className="flex items-center gap-3">
                        <div className="rounded-md border border-gray-200 bg-gray-50 p-2">
                          <CardIcon type={card.type} />
                        </div>
                        <span className="text-sm font-bold text-gray-900">{card.name}</span>
                      </div>
                    </td>
                    <td data-label="类型">
                      {/* 四类卡券用同一套低饱和色阶区分，不用纯蓝/紫/橙/粉 ——
                          表格里几十行并排时，高饱和标签会盖过内容本身 */}
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${
                        card.type === 'text' ? 'bg-[#fff8d1] text-[#8a6300]' :
                        card.type === 'data' ? 'bg-[#eef4ff] text-[#3f5f8f]' :
                        card.type === 'api' ? 'bg-[#f0f7f3] text-[#3f7a5c]' :
                        'bg-[#f7f2fb] text-[#6b5a8a]'
                      }`}>
                        {card.type === 'text' ? '文本' :
                         card.type === 'data' ? '批量' :
                         card.type === 'api' ? 'API' : '图片'}
                      </span>
                    </td>
                    <td data-label="内容 / 库存">
                      <span className="block max-w-[260px] truncate font-mono text-xs text-gray-600" title={stockInfo}>
                        {stockInfo}
                      </span>
                    </td>
                    <td data-label="说明">
                      <span
                        className="block max-w-[220px] truncate text-sm text-gray-500"
                        title={card.description || '-'}
                      >
                        {card.description || '-'}
                      </span>
                    </td>
                    <td data-label="状态">
                      <button
                        onClick={() => toggleCardStatus(card)}
                        className={`relative h-6 w-10 rounded-full transition-colors ${
                          card.enabled ? 'bg-[#ffe100]' : 'bg-gray-300'
                        }`}
                        title={card.enabled ? '停用' : '启用'}
                        aria-label={`${card.enabled ? '停用' : '启用'}卡密 ${card.name}`}
                      >
                        <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                          card.enabled ? 'left-5' : 'left-1'
                        }`} />
                      </button>
                    </td>
                    <td data-label="操作">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleEdit(card)}
                          className="rounded-md p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-black"
                          title="编辑"
                          aria-label={`编辑卡密 ${card.name}`}
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        {readAccountDeliveryCard(card) && connectionCards.length > 0 && (
                          <button
                            onClick={() => openAddModal(card)}
                            className="rounded-md p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-black"
                            title="复制并选择账号池"
                            aria-label={`复制卡密 ${card.name}`}
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(card.id)}
                          className="rounded-md p-2 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600"
                          title="删除"
                          aria-label={`删除卡密 ${card.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {cards.length === 0 && (
          <div className="p-4">
            <EmptyState
              compact
              icon={Package}
              title="暂无卡密配置"
              description="添加固定文本、批量卡密、图片或 API 数据源后，可在商品发货策略中直接选择。"
            />
          </div>
        )}
      </section>

      {/* 编辑卡密弹窗 - 使用 Portal */}
      {showEditModal && selectedCard && createPortal(
        <div className="modal-overlay">
          <div className="modal-container">
            <div className="modal-header">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">编辑卡密</h3>
                  <p className="mt-1 text-xs text-gray-500">修改数据源内容及发货调用方式。</p>
                </div>
                <button
                  onClick={() => setShowEditModal(false)}
                  className="rounded-md p-2 hover:bg-gray-100"
                  aria-label="关闭编辑卡密"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
            </div>

            <div className="modal-body">
              <div className="space-y-5">
                {/* 基本信息 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-2">卡密名称 <span className="text-red-500">*</span></label>
                    <input
                      type="text"
                      value={editForm.name || ''}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className="ios-input w-full rounded-md px-3 py-2.5"
                      placeholder="例如：游戏点卡、会员卡等"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-2">卡券类型</label>
                    <select
                      value={editForm.type || 'text'}
                      onChange={(e) => setEditForm({ ...editForm, type: e.target.value as any })}
                      className="ios-input w-full rounded-md px-3 py-2.5"
                    >
                      <option value="">请选择类型</option>
                      <option value="text">固定文字</option>
                      <option value="data">批量数据</option>
                      <option value="api">API接口</option>
                      <option value="image">图片</option>
                    </select>
                  </div>
                </div>

                {/* API 配置 */}
                {editForm.type === 'api' && (
                  <div className="space-y-4 rounded-md border border-gray-200 bg-gray-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="font-bold text-gray-900">
                        {readAccountDeliveryCard(selectedCard) ? '账号系统提取码' : '自定义 API'}
                      </h3>
                      {readAccountDeliveryCard(selectedCard) && (
                        <button
                          type="button"
                          onClick={() => setEditApiMode(editApiMode === 'managed' ? 'custom' : 'managed')}
                          className="text-xs font-semibold text-gray-600 underline"
                        >
                          {editApiMode === 'managed' ? '高级配置' : '返回简易配置'}
                        </button>
                      )}
                    </div>
                    {editApiMode === 'managed' ? (
                      <>
                        <AccountPoolFields
                          selectedId={editPoolId}
                          pools={pools}
                          status={poolStatus}
                          error={poolError}
                          onChange={setEditPoolId}
                          onRetry={() => setPoolRefresh(value => value + 1)}
                        />
                        <DurationFields
                          amount={editDurationAmount}
                          unit={editDurationUnit}
                          onAmountChange={setEditDurationAmount}
                          onUnitChange={setEditDurationUnit}
                        />
                        <p className="text-xs text-gray-500">接口地址、连接密钥和订单参数保持当前设置。新商品需要不同账号池或时长时，建议新增卡密再绑定到商品。</p>
                      </>
                    ) : (
                    <>
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-2">API 地址</label>
                      <input
                        type="url"
                        value={editForm.api_url || ''}
                        onChange={(e) => setEditForm({ ...editForm, api_url: e.target.value })}
                        className="ios-input w-full rounded-md px-3 py-2.5 font-mono text-sm"
                        placeholder="https://api.example.com/get-card"
                      />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="block text-sm font-bold text-gray-700 mb-2">请求方法</label>
                        <select
                          value={editForm.api_method || 'GET'}
                          onChange={(e) => setEditForm({ ...editForm, api_method: e.target.value as 'GET' | 'POST' })}
                          className="ios-input w-full rounded-md px-3 py-2.5"
                        >
                          <option value="GET">GET</option>
                          <option value="POST">POST</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-gray-700 mb-2">超时时间（秒）</label>
                        <input
                          type="number"
                          value={editForm.api_timeout || 10}
                          onChange={(e) => setEditForm({ ...editForm, api_timeout: parseInt(e.target.value) || 10 })}
                          className="ios-input w-full rounded-md px-3 py-2.5"
                          min="1"
                          max="60"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-2">请求头（JSON 格式）</label>
                      <textarea
                        value={editForm.api_headers || ''}
                        onChange={(e) => setEditForm({ ...editForm, api_headers: e.target.value })}
                        className="ios-input h-20 w-full resize-y rounded-md px-3 py-2.5 font-mono text-sm"
                        placeholder='{"Authorization": "Bearer token"}'
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-2">请求参数（JSON 格式）</label>
                      <textarea
                        value={editForm.api_params || ''}
                        onChange={(e) => setEditForm({ ...editForm, api_params: e.target.value })}
                        className="ios-input h-20 w-full resize-y rounded-md px-3 py-2.5 font-mono text-sm"
                        placeholder='{"type": "card", "count": 1}'
                      />
                      <p className="mt-2 text-xs text-gray-500">
                        POST 可使用 {'{order_id}'}、{'{item_id}'}、{'{cookie_id}'}、{'{delivery_index}'}；发货序号从 1 开始。
                      </p>
                    </div>
                    </>
                    )}
                  </div>
                )}

                {/* 固定文字配置 */}
                {editForm.type === 'text' && (
                  <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
                    <h3 className="font-bold text-gray-900 mb-3">固定文字配置</h3>
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-2">文字内容</label>
                      <textarea
                        value={editForm.text_content || ''}
                        onChange={(e) => setEditForm({ ...editForm, text_content: e.target.value })}
                        className="ios-input h-32 w-full resize-y rounded-md px-3 py-2.5"
                        placeholder="请输入要发送的固定文字内容..."
                      />
                    </div>
                  </div>
                )}

                {/* 批量数据配置 */}
                {editForm.type === 'data' && (
                  <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
                    <h3 className="font-bold text-gray-900 mb-3">批量数据配置</h3>
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-2">数据内容（一行一个）</label>
                      <textarea
                        value={editForm.data_content || ''}
                        onChange={(e) => setEditForm({ ...editForm, data_content: e.target.value })}
                        className="ios-input h-72 w-full resize-y rounded-md px-3 py-2.5 font-mono text-sm"
                        placeholder="请输入数据，每行一个：&#10;卡号1:密码1&#10;卡号2:密码2&#10;或者&#10;兑换码1&#10;兑换码2"
                      />
                      <p className="text-xs text-gray-500 mt-2">支持格式：卡号:密码 或 单独的兑换码</p>
                      <p className="text-xs text-gray-500">当前库存：<span className="font-bold text-amber-600">
                        {editForm.data_content ? editForm.data_content.split('\n').filter(line => line.trim()).length : 0}
                      </span> 条</p>
                    </div>
                  </div>
                )}

                {/* 图片配置 */}
                {editForm.type === 'image' && (
                  <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
                    <h3 className="font-bold text-gray-900 mb-3">图片配置</h3>
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-2">图片 URL</label>
                      <input
                        type="url"
                        value={editForm.image_url || ''}
                        onChange={(e) => setEditForm({ ...editForm, image_url: e.target.value })}
                        className="ios-input w-full rounded-md px-3 py-2.5 font-mono text-sm"
                        placeholder="https://example.com/image.png"
                      />
                      <p className="text-xs text-gray-500 mt-2">输入图片卡密的 URL 地址</p>
                    </div>
                    {editForm.image_url && (
                      <div className="mt-3">
                        <label className="block text-sm font-bold text-gray-700 mb-2">图片预览</label>
                        <img
                          src={editForm.image_url}
                          alt="预览"
                          className="max-h-48 max-w-full rounded-md border border-gray-200"
                          onError={(e) => { e.currentTarget.src = 'https://via.placeholder.com/400x200?text=图片加载失败'; }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* 延时发货时间 */}
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">延时发货时间（秒）</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={editForm.delay_seconds || 0}
                      onChange={(e) => setEditForm({ ...editForm, delay_seconds: parseInt(e.target.value) || 0 })}
                      className="ios-input flex-1 rounded-md px-3 py-2.5"
                      min="0"
                      max="3600"
                      placeholder="0"
                    />
                    <span className="text-sm text-gray-500 whitespace-nowrap">秒</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">0表示立即发货，最大3600秒（1小时）</p>
                </div>

                {/* 备注信息 */}
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">发货说明（买家可见）</label>
                  <textarea
                    value={editForm.description || ''}
                    onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    className="ios-input h-32 w-full resize-y rounded-md px-3 py-2.5"
                    placeholder="可选的备注信息"
                  />
                  <p className="mt-2 text-xs text-gray-500">会与提取码一起发送给买家。留空则只发送提取码。</p>
                </div>

                {/* 启用状态 */}
                <div className="flex items-center justify-between gap-4 rounded-md border border-gray-200 bg-gray-50 p-4">
                  <span className="font-bold text-gray-900">启用状态</span>
                  <button
                    type="button"
                    onClick={() => setEditForm({ ...editForm, enabled: !editForm.enabled })}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      editForm.enabled ? 'bg-[#ffe100]' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`absolute left-1 top-1 block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                        editForm.enabled ? 'translate-x-5' : ''
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <div className="flex w-full gap-2">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="ios-btn-secondary flex-1 rounded-md px-4 py-2.5 text-sm"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  className="ios-btn-primary flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm"
                >
                  <Save className="w-4 h-4" />
                  保存更改
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 添加新卡密弹窗 - 使用 Portal */}
      {showAddModal && createPortal(
        <div className="modal-overlay">
          <div className="modal-container">
            <div className="modal-header">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">添加卡密</h3>
                  <p className="mt-1 text-xs text-gray-500">创建可复用的自动发货内容或库存来源。</p>
                </div>
                <button
                  onClick={() => setShowAddModal(false)}
                  className="rounded-md p-2 hover:bg-gray-100"
                  aria-label="关闭添加卡密"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
            </div>

            <div className="modal-body">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">卡密名称</label>
                  <input
                    type="text"
                    value={addForm.name}
                    onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                    placeholder="例如：VIP会员卡密"
                    className="ios-input w-full rounded-md px-3 py-2.5"
                  />
                </div>

                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">类型</label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <button
                      type="button"
                      onClick={() => setAddForm({ ...addForm, type: 'text' })}
                      className={`rounded-md border p-3 text-sm font-bold transition-colors ${addForm.type === 'text' ? 'border-amber-400 bg-[#ffe100] text-black' : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
                    >
                      <FileText className="w-5 h-5 mx-auto mb-1" />
                      文本
                    </button>
                    <button
                      type="button"
                      onClick={() => setAddForm({ ...addForm, type: 'data' })}
                      className={`rounded-md border p-3 text-sm font-bold transition-colors ${addForm.type === 'data' ? 'border-amber-400 bg-[#ffe100] text-black' : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
                    >
                      <Package className="w-5 h-5 mx-auto mb-1" />
                      批量
                    </button>
                    <button
                      type="button"
                      onClick={() => setAddForm({ ...addForm, type: 'image' })}
                      className={`rounded-md border p-3 text-sm font-bold transition-colors ${addForm.type === 'image' ? 'border-amber-400 bg-[#ffe100] text-black' : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
                    >
                      <ImageIcon className="w-5 h-5 mx-auto mb-1" />
                      图片
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const source = connectionCards[0];
                        setAddForm({
                          ...addForm,
                          type: 'api',
                          api_mode: source ? 'managed' : 'custom',
                          source_card_id: source?.id ?? null,
                        });
                      }}
                      className={`rounded-md border p-3 text-sm font-bold transition-colors ${addForm.type === 'api' ? 'border-amber-400 bg-[#ffe100] text-black' : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
                    >
                      <Code className="w-5 h-5 mx-auto mb-1" />
                      API
                    </button>
                  </div>
                </div>

                {addForm.type === 'api' && (
                  <div className="space-y-4 rounded-md border border-gray-200 bg-gray-50 p-4">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={connectionCards.length === 0}
                        onClick={() => setAddForm({ ...addForm, api_mode: 'managed', source_card_id: addForm.source_card_id ?? connectionCards[0].id })}
                        className={`rounded-md border p-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${addForm.api_mode === 'managed' ? 'border-amber-400 bg-[#fff6c4]' : 'border-gray-200 bg-white'}`}
                      >
                        账号系统提取码
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddForm({ ...addForm, api_mode: 'custom' })}
                        className={`rounded-md border p-2 text-sm font-semibold ${addForm.api_mode === 'custom' ? 'border-amber-400 bg-[#fff6c4]' : 'border-gray-200 bg-white'}`}
                      >
                        自定义 API
                      </button>
                    </div>
                    {connectionCards.length === 0 && (
                      <p className="text-xs text-amber-800">服务器内网取码连接尚未配置，请管理员先在高级配置中完成首次接入。</p>
                    )}
                    {addForm.api_mode === 'managed' ? (
                      <>
                        <AccountPoolFields
                          selectedId={addForm.pool_id}
                          pools={pools}
                          status={poolStatus}
                          error={poolError}
                          onChange={(pool_id) => setAddForm({ ...addForm, pool_id })}
                          onRetry={() => setPoolRefresh(value => value + 1)}
                        />
                        <DurationFields
                          amount={addForm.duration_amount}
                          unit={addForm.duration_unit}
                          onAmountChange={(value) => setAddForm({ ...addForm, duration_amount: value })}
                          onUnitChange={(value) => setAddForm({ ...addForm, duration_unit: value })}
                        />
                      </>
                    ) : (
                      <div>
                        <label className="mb-2 block text-sm font-bold text-gray-700">API 地址 <span className="text-red-500">*</span></label>
                        <input
                          type="url"
                          value={addForm.content}
                          onChange={(event) => setAddForm({ ...addForm, content: event.target.value })}
                          placeholder="https://api.example.com/get-code"
                          className="ios-input w-full rounded-md px-3 py-2.5"
                        />
                        <p className="mt-2 text-xs text-gray-500">自定义接口创建后，请进入编辑页的高级配置填写请求方法、请求头和参数。没有取码连接时由管理员完成首次接入。</p>
                      </div>
                    )}
                  </div>
                )}

                {addForm.type !== 'api' && (
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-2">
                      {addForm.type === 'text' ? '固定文字' : addForm.type === 'data' ? '批量数据（一行一个）' : '图片 URL'}
                    </label>
                    <textarea
                      value={addForm.content}
                      onChange={(e) => setAddForm({ ...addForm, content: e.target.value })}
                      className="ios-input h-36 w-full resize-y rounded-md px-3 py-2.5 font-mono text-sm"
                      placeholder={
                        addForm.type === 'text'
                          ? '请输入自动发送的固定文字'
                          : addForm.type === 'data'
                            ? 'CODE-123456\nCODE-789012\n...'
                            : 'https://example.com/image.jpg'
                      }
                    />
                    {addForm.type === 'data' && (
                      <p className="text-xs text-gray-500 mt-2">
                        当前库存：{addForm.content.split('\n').filter(line => line.trim()).length} 条
                      </p>
                    )}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">发货说明（买家可见）</label>
                  <textarea
                    value={addForm.description}
                    onChange={(e) => setAddForm({ ...addForm, description: e.target.value })}
                    placeholder="例如：请用下方提取码进入账号提取页面"
                    className="ios-input h-20 w-full resize-y rounded-md px-3 py-2.5"
                  />
                  <p className="mt-2 text-xs text-gray-500">复制卡密时会沿用原说明，修改后将与提取码一起发送给买家。</p>
                </div>

                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">延时发货（秒）</label>
                  <input
                    type="number"
                    value={addForm.delay_seconds}
                    onChange={(e) => setAddForm({ ...addForm, delay_seconds: parseInt(e.target.value) || 0 })}
                    className="ios-input w-full rounded-md px-3 py-2.5"
                    min="0"
                    placeholder="0"
                  />
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <div className="flex w-full gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="ios-btn-secondary flex-1 rounded-md px-4 py-2.5 text-sm"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleAddCard}
                  className="ios-btn-primary flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm"
                >
                  <Plus className="w-4 h-4" />
                  添加卡密
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default CardList;
