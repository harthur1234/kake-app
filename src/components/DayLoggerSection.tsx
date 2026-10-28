import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bike,
  Check,
  Droplets,
  Dumbbell,
  Edit2,
  HelpCircle,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import {
  applyDayLogDraftToStore,
  type ConversationTurn,
  type DayLogDraft,
  type DayLogMealItem,
  processUserNarration,
  type Slot,
  type Store,
} from '../lib/dayLogger'

export interface DayLoggerSectionProps {
  store: Store
  updateStore: (updater: (current: Store) => Store) => void
  notify: (text: string) => void
  geminiKey?: string
  today: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  clarifyingQuestions?: string[]
  status?: 'needs_clarification' | 'ready_to_confirm' | 'error'
  timestamp: string
}

const AVAILABLE_SLOTS: Slot[] = [
  'Café / Merenda',
  'Almoço',
  'Pré-Treino',
  'Jantar',
  'Refeição Livre / Lanche',
  'Merenda da Escola',
  'Jantar Único',
]

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

function formatTimestamp(): string {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export const DayLoggerSection: React.FC<DayLoggerSectionProps> = ({
  store: _store,
  updateStore,
  notify,
  geminiKey,
  today,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: 'welcome-msg',
      role: 'assistant',
      content:
        'Olá! Conte como foi seu dia: o que você comeu nas refeições, água consumida, creatina, pedaladas ou treino na academia. Eu extraio todos os dados e calculo os macronutrientes automaticamente.',
      timestamp: formatTimestamp(),
    },
  ])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [draft, setDraft] = useState<DayLogDraft | null>(null)
  const [isEditingInline, setIsEditingInline] = useState(false)
  const [showAddMealForm, setShowAddMealForm] = useState(false)
  const [newMealName, setNewMealName] = useState('')
  const [newMealGrams, setNewMealGrams] = useState(100)
  const [newMealSlot, setNewMealSlot] = useState<Slot>('Almoço')

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isSubmittingRef = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading, draft])

  // Macro totals of current draft
  const draftTotals = useMemo(() => {
    if (!draft || !draft.meals || draft.meals.length === 0) {
      return { kcal: 0, protein: 0, carbs: 0, fat: 0, count: 0 }
    }
    return draft.meals.reduce(
      (acc, item) => ({
        kcal: acc.kcal + (item.kcal || 0),
        protein: Number((acc.protein + (item.protein || 0)).toFixed(1)),
        carbs: Number((acc.carbs + (item.carbs || 0)).toFixed(1)),
        fat: Number((acc.fat + (item.fat || 0)).toFixed(1)),
        count: acc.count + 1,
      }),
      { kcal: 0, protein: 0, carbs: 0, fat: 0, count: 0 }
    )
  }, [draft])

  // Group meals by slot
  const groupedMeals = useMemo(() => {
    if (!draft || !draft.meals) return {} as Record<string, Array<{ item: DayLogMealItem; globalIndex: number }>>
    const groups: Record<string, Array<{ item: DayLogMealItem; globalIndex: number }>> = {}
    draft.meals.forEach((item, globalIndex) => {
      const s = item.slot || 'Refeição Livre / Lanche'
      if (!groups[s]) groups[s] = []
      groups[s].push({ item, globalIndex })
    })
    return groups
  }, [draft])

  // Send message to Gemini / dayLogger engine
  const handleSendMessage = useCallback(
    async (textToSend?: string) => {
      const content = (textToSend ?? input).trim()
      if (!content || isLoading) return

      setInput('')
      const userMessage: ChatMessage = {
        id: generateId(),
        role: 'user',
        content,
        timestamp: formatTimestamp(),
      }

      setMessages((prev) => [...prev, userMessage])
      setIsLoading(true)

      const history: ConversationTurn[] = messages
        .filter((m) => m.id !== 'welcome-msg')
        .map((m) => ({
          role: m.role,
          content: m.content,
        }))

      try {
        const turnResult = await processUserNarration(content, history, draft, geminiKey)

        if (turnResult.status === 'ready_to_confirm') {
          if (turnResult.draft) {
            setDraft(turnResult.draft)
          }
          setMessages((prev) => [
            ...prev,
            {
              id: generateId(),
              role: 'assistant',
              content:
                turnResult.replyMessage ||
                'Tudo esclarecido! Confira o resumo completo do seu dia no cartão abaixo antes de confirmar.',
              status: 'ready_to_confirm',
              timestamp: formatTimestamp(),
            },
          ])
        } else if (turnResult.status === 'needs_clarification') {
          if (turnResult.draft) {
            setDraft(turnResult.draft)
          }
          setMessages((prev) => [
            ...prev,
            {
              id: generateId(),
              role: 'assistant',
              content: turnResult.replyMessage,
              clarifyingQuestions: turnResult.clarifyingQuestions,
              status: 'needs_clarification',
              timestamp: formatTimestamp(),
            },
          ])
        } else {
          // status === 'error'
          setMessages((prev) => [
            ...prev,
            {
              id: generateId(),
              role: 'assistant',
              content:
                turnResult.replyMessage ||
                'Não foi possível processar a mensagem. Por favor, verifique os dados informados.',
              status: 'error',
              timestamp: formatTimestamp(),
            },
          ])
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: 'assistant',
            content: `Ocorreu uma falha ao analisar a mensagem: ${msg}. Tente novamente.`,
            status: 'error',
            timestamp: formatTimestamp(),
          },
        ])
      } finally {
        setIsLoading(false)
      }
    },
    [draft, geminiKey, input, isLoading, messages]
  )

  // Handle Enter key in textarea
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  // Double-click guarded confirmation mutex
  const handleConfirm = useCallback(() => {
    if (isSubmittingRef.current || !draft) return
    isSubmittingRef.current = true
    setIsSubmitting(true)

    try {
      updateStore((currentStore) => {
        const { updatedStore } = applyDayLogDraftToStore(currentStore, draft, today)
        return { ...updatedStore }
      })

      notify('Registros salvos com sucesso no Hoje!')

      setDraft(null)
      setIsEditingInline(false)
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: 'assistant',
          content:
            'Registros salvos com sucesso no Hoje! As refeições, água, creatina e atividades físicas já foram atualizadas nas abas Hoje, Comida e Treinos.',
          timestamp: formatTimestamp(),
        },
      ])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      notify(`Erro ao salvar os registros do dia: ${msg}`)
    } finally {
      setTimeout(() => {
        isSubmittingRef.current = false
        setIsSubmitting(false)
      }, 500)
    }
  }, [draft, notify, today, updateStore])

  // Cancellation handler (resets draft, leaves store 100% untouched)
  const handleCancel = useCallback(() => {
    setDraft(null)
    setIsEditingInline(false)
    notify('Rascunho cancelado. Nenhum dado foi salvo.')
    setMessages((prev) => [
      ...prev,
      {
        id: generateId(),
        role: 'assistant',
        content: 'Rascunho descartado. Nenhum dado foi alterado no seu histórico.',
        timestamp: formatTimestamp(),
      },
    ])
  }, [notify])

  // Reset entire conversation
  const handleResetChat = useCallback(() => {
    setDraft(null)
    setIsEditingInline(false)
    setMessages([
      {
        id: generateId(),
        role: 'assistant',
        content:
          'Conversa reiniciada. Conte sobre suas refeições, água, creatina e treinos de hoje para começar um novo registro.',
        timestamp: formatTimestamp(),
      },
    ])
  }, [])

  // Inline Meal Edits
  const handleUpdateItemGrams = (globalIndex: number, newGrams: number) => {
    if (!draft || !draft.meals[globalIndex]) return
    const safeGrams = Math.max(0, Math.min(5000, newGrams))
    const currentItem = draft.meals[globalIndex]
    const ratio = currentItem.grams > 0 ? safeGrams / currentItem.grams : 1

    const updatedMeals = draft.meals.map((item, idx) => {
      if (idx !== globalIndex) return item
      return {
        ...item,
        grams: safeGrams,
        kcal: Math.round(item.kcal * ratio),
        protein: Number((item.protein * ratio).toFixed(1)),
        carbs: Number((item.carbs * ratio).toFixed(1)),
        fat: Number((item.fat * ratio).toFixed(1)),
      }
    })

    setDraft({ ...draft, meals: updatedMeals })
  }

  const handleRemoveMealItem = (globalIndex: number) => {
    if (!draft) return
    const nextMeals = draft.meals.filter((_, idx) => idx !== globalIndex)
    setDraft({ ...draft, meals: nextMeals })
  }

  const handleAddNewMealItem = (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft || !newMealName.trim()) return

    const newItem: DayLogMealItem = {
      name: newMealName.trim(),
      grams: newMealGrams,
      kcal: Math.round(newMealGrams * 1.5),
      protein: Number((newMealGrams * 0.1).toFixed(1)),
      carbs: Number((newMealGrams * 0.2).toFixed(1)),
      fat: Number((newMealGrams * 0.03).toFixed(1)),
      slot: newMealSlot,
      isCustomFood: true,
    }

    setDraft({
      ...draft,
      meals: [...draft.meals, newItem],
    })

    setNewMealName('')
    setNewMealGrams(100)
    setShowAddMealForm(false)
  }

  // Pillar update helpers
  const handleUpdateWater = (delta: number) => {
    if (!draft) return
    const current = draft.waterMl ?? 0
    const nextVal = Math.max(0, Math.min(10000, current + delta))
    setDraft({ ...draft, waterMl: nextVal })
  }

  const handleSetWaterDirect = (ml: number) => {
    if (!draft) return
    setDraft({ ...draft, waterMl: Math.max(0, Math.min(10000, ml)) })
  }

  const handleToggleCreatine = (val: boolean) => {
    if (!draft) return
    setDraft({ ...draft, creatine: val })
  }

  const handleUpdateBikeKm = (km: number) => {
    if (!draft) return
    if (km <= 0) {
      const { bikeActivity: _, ...rest } = draft
      setDraft(rest)
    } else {
      setDraft({
        ...draft,
        bikeActivity: {
          km: Number(km.toFixed(1)),
          minutes: draft.bikeActivity?.minutes,
          label: draft.bikeActivity?.label || 'Pedalada registrada via Diário IA',
        },
      })
    }
  }

  const handleUpdateWorkoutGroup = (group: 'A' | 'B' | 'C' | null) => {
    if (!draft) return
    if (!group) {
      const { gymWorkout: _, ...rest } = draft
      setDraft(rest)
    } else {
      setDraft({
        ...draft,
        gymWorkout: {
          group,
          label: `Treino ${group}`,
        },
      })
    }
  }

  return (
    <div className="day-logger-section fade-in">
      {/* Top Heading */}
      <div className="page-heading">
        <div>
          <div className="eyebrow">REGISTRO CONVERSACIONAL · GEMINI</div>
          <h1>Diário IA</h1>
        </div>
        <span className="live-dot">● IA ATIVA</span>
      </div>

      {/* Main Conversational Card */}
      <section className="card day-logger-card" aria-label="Chat com assistente de nutrição e treino">
        <div className="card-heading">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="icon-orb">
              <Sparkles size={20} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: 16 }}>Diário do Dia</h2>
              <span className="supporting-text" style={{ fontSize: 11 }}>
                Converse livremente sobre o que comeu, bebeu ou treinou
              </span>
            </div>
          </div>
          <button
            type="button"
            className="day-logger-reset-btn"
            onClick={handleResetChat}
            title="Reiniciar conversa"
            aria-label="Reiniciar conversa"
          >
            <RotateCcw size={14} />
            <span>Limpar</span>
          </button>
        </div>

        {/* Quick starter chips */}
        {messages.length <= 1 && (
          <div className="quick-prompt-chips" aria-label="Sugestões de início">
            <span className="quick-prompt-label">Sugestões rápidas:</span>
            <button
              type="button"
              className="quick-chip"
              onClick={() =>
                handleSendMessage(
                  'Fui de bike para a escola 2,5 km, no almoço comi 130g de lombo, 100g de arroz e 30g de feijão, depois 100g de batata frita, treinei o treino A, voltei de bike 2,5 km, tomei 2000ml de água e creatina.'
                )
              }
            >
              🚲 Dia completo (Bike + Almoço + Treino A + Água)
            </button>
            <button
              type="button"
              className="quick-chip"
              onClick={() =>
                handleSendMessage(
                  'No almoço comi 150g de peito de frango grelhado, 150g de arroz branco e 80g de feijão preto.'
                )
              }
            >
              🍗 Almoço básico (Frango + Arroz + Feijão)
            </button>
            <button
              type="button"
              className="quick-chip"
              onClick={() =>
                handleSendMessage('Pedalei 12 km de manhã e tomei 2500 ml de água com creatina.')
              }
            >
              💧 Hidratação e pedalada (12 km + 2,5L água)
            </button>
          </div>
        )}

        {/* Chat Messages Log */}
        <div className="chat-messages-container" aria-live="polite">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`chat-bubble-row ${msg.role === 'user' ? 'user-row' : 'assistant-row'}`}
            >
              {msg.role === 'assistant' && (
                <div className="chat-avatar assistant-avatar" aria-hidden="true">
                  <Sparkles size={14} />
                </div>
              )}

              <div
                className={`chat-bubble ${msg.role === 'user' ? 'user-bubble' : 'assistant-bubble'} ${
                  msg.status === 'error' ? 'error-bubble' : ''
                }`}
              >
                <div className="chat-bubble-content">{msg.content}</div>

                {/* Clarification questions box */}
                {msg.clarifyingQuestions && msg.clarifyingQuestions.length > 0 && (
                  <div className="clarification-card">
                    <div className="clarification-title">
                      <HelpCircle size={14} />
                      <span>Perguntas para esclarecer:</span>
                    </div>
                    <ul className="clarification-list">
                      {msg.clarifyingQuestions.map((q, idx) => (
                        <li key={idx} className="clarification-item">
                          {q}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <span className="chat-bubble-time">{msg.timestamp}</span>
              </div>
            </div>
          ))}

          {/* Typing Indicator */}
          {isLoading && (
            <div className="chat-bubble-row assistant-row">
              <div className="chat-avatar assistant-avatar" aria-hidden="true">
                <Sparkles size={14} />
              </div>
              <div className="chat-bubble assistant-bubble typing-bubble">
                <div className="typing-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
                <span className="typing-text">Analisando seu dia com IA...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Confirmation Summary Card (when draft exists) */}
        {draft && (
          <div className="day-logger-summary-card card-enter" aria-label="Resumo para confirmação">
            <div className="summary-card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="summary-status-badge">PRONTO PARA CONFIRMAR</span>
                <span className="summary-date-tag">{today}</span>
              </div>
              <button
                type="button"
                className={`summary-edit-toggle ${isEditingInline ? 'active' : ''}`}
                onClick={() => setIsEditingInline((prev) => !prev)}
                aria-label="Alternar edição manual"
              >
                <Edit2 size={13} />
                <span>{isEditingInline ? 'Concluir edição' : 'Editar dados'}</span>
              </button>
            </div>

            {/* Macro Totals Ribbon */}
            <div className="summary-macros-strip">
              <div className="macro-chip macro-kcal">
                <span className="macro-chip-label">Calorias</span>
                <strong className="macro-chip-val">{draftTotals.kcal} kcal</strong>
              </div>
              <div className="macro-chip macro-p">
                <span className="macro-chip-label">Proteína</span>
                <strong className="macro-chip-val">{draftTotals.protein}g</strong>
              </div>
              <div className="macro-chip macro-c">
                <span className="macro-chip-label">Carboidratos</span>
                <strong className="macro-chip-val">{draftTotals.carbs}g</strong>
              </div>
              <div className="macro-chip macro-g">
                <span className="macro-chip-label">Gordura</span>
                <strong className="macro-chip-val">{draftTotals.fat}g</strong>
              </div>
            </div>

            {/* Grouped Meals by Slot */}
            <div className="summary-section-box">
              <div className="summary-section-title">
                <span>Refeições Registradas ({draft.meals.length})</span>
                {isEditingInline && (
                  <button
                    type="button"
                    className="summary-add-item-btn"
                    onClick={() => setShowAddMealForm((p) => !p)}
                  >
                    <Plus size={12} />
                    <span>Adicionar item</span>
                  </button>
                )}
              </div>

              {/* Inline Add Meal Form */}
              {showAddMealForm && (
                <form className="summary-add-form" onSubmit={handleAddNewMealItem}>
                  <input
                    type="text"
                    placeholder="Nome do alimento"
                    value={newMealName}
                    onChange={(e) => setNewMealName(e.target.value)}
                    required
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="number"
                      placeholder="Gramas"
                      value={newMealGrams}
                      onChange={(e) => setNewMealGrams(Number(e.target.value))}
                      style={{ width: 80 }}
                      min={1}
                      max={3000}
                    />
                    <select
                      value={newMealSlot}
                      onChange={(e) => setNewMealSlot(e.target.value as Slot)}
                    >
                      {AVAILABLE_SLOTS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="primary-btn" style={{ padding: '6px 12px' }}>
                      Adicionar
                    </button>
                  </div>
                </form>
              )}

              {Object.keys(groupedMeals).length === 0 ? (
                <div className="summary-empty-text">Nenhuma refeição no rascunho.</div>
              ) : (
                Object.entries(groupedMeals).map(([slotName, items]) => {
                  const slotKcal = items.reduce((sum, i) => sum + (i.item.kcal || 0), 0)
                  return (
                    <div key={slotName} className="summary-meal-group">
                      <div className="summary-group-header">
                        <strong>{slotName}</strong>
                        <span className="summary-group-subtotal">{slotKcal} kcal</span>
                      </div>
                      <div className="summary-items-list">
                        {items.map(({ item, globalIndex }) => (
                          <div key={globalIndex} className="summary-item-row">
                            <div className="summary-item-info">
                              <span className="summary-item-name">{item.name}</span>
                              {item.isCustomFood && (
                                <span className="custom-food-tag">IA Gemini</span>
                              )}
                              <span className="summary-item-macros">
                                {item.kcal} kcal · P: {item.protein}g · C: {item.carbs}g · G:{' '}
                                {item.fat}g
                              </span>
                            </div>

                            <div className="summary-item-controls">
                              {isEditingInline ? (
                                <div className="inline-grams-editor">
                                  <input
                                    type="number"
                                    min={0}
                                    max={3000}
                                    value={item.grams}
                                    onChange={(e) =>
                                      handleUpdateItemGrams(globalIndex, Number(e.target.value))
                                    }
                                    aria-label={`Gramas de ${item.name}`}
                                  />
                                  <span>g</span>
                                  <button
                                    type="button"
                                    className="item-remove-btn"
                                    onClick={() => handleRemoveMealItem(globalIndex)}
                                    title="Remover alimento"
                                    aria-label={`Remover ${item.name}`}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              ) : (
                                <span className="summary-item-grams">{item.grams}g</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {/* Other Pillars: Water, Creatine, Bike, Gym */}
            <div className="summary-pillars-grid">
              {/* Water Card */}
              <div className="summary-pillar-card">
                <div className="pillar-header">
                  <div className="pillar-icon pillar-water">
                    <Droplets size={16} />
                  </div>
                  <strong>Água</strong>
                </div>
                <div className="pillar-body">
                  {isEditingInline ? (
                    <div className="pillar-inline-edit">
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        step={100}
                        value={draft.waterMl ?? 0}
                        onChange={(e) => handleSetWaterDirect(Number(e.target.value))}
                        aria-label="Água em ml"
                      />
                      <span>ml</span>
                    </div>
                  ) : (
                    <div className="pillar-value">
                      {draft.waterMl !== undefined && draft.waterMl !== null
                        ? `${draft.waterMl} ml`
                        : 'Não informado'}
                    </div>
                  )}
                  <div className="pillar-quick-btns">
                    <button
                      type="button"
                      onClick={() => handleUpdateWater(250)}
                      title="+250ml de água"
                    >
                      +250ml
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUpdateWater(500)}
                      title="+500ml de água"
                    >
                      +500ml
                    </button>
                  </div>
                </div>
              </div>

              {/* Creatine Card */}
              <div className="summary-pillar-card">
                <div className="pillar-header">
                  <div className="pillar-icon pillar-creatine">
                    <Zap size={16} />
                  </div>
                  <strong>Creatina</strong>
                </div>
                <div className="pillar-body">
                  <div className="creatine-toggle-group">
                    <button
                      type="button"
                      className={`creatine-btn ${draft.creatine === true ? 'active-sim' : ''}`}
                      onClick={() => handleToggleCreatine(true)}
                    >
                      Sim
                    </button>
                    <button
                      type="button"
                      className={`creatine-btn ${draft.creatine === false ? 'active-nao' : ''}`}
                      onClick={() => handleToggleCreatine(false)}
                    >
                      Não
                    </button>
                  </div>
                </div>
              </div>

              {/* Bike Activity Card */}
              <div className="summary-pillar-card">
                <div className="pillar-header">
                  <div className="pillar-icon pillar-bike">
                    <Bike size={16} />
                  </div>
                  <strong>Pedalada (Bike)</strong>
                </div>
                <div className="pillar-body">
                  {isEditingInline ? (
                    <div className="pillar-inline-edit">
                      <input
                        type="number"
                        min={0}
                        max={300}
                        step={0.5}
                        value={draft.bikeActivity?.km ?? 0}
                        onChange={(e) => handleUpdateBikeKm(Number(e.target.value))}
                        aria-label="Distância em km de bike"
                      />
                      <span>km</span>
                    </div>
                  ) : (
                    <div className="pillar-value">
                      {draft.bikeActivity && draft.bikeActivity.km > 0
                        ? `${draft.bikeActivity.km} km${
                            draft.bikeActivity.minutes ? ` (${draft.bikeActivity.minutes} min)` : ''
                          }`
                        : 'Nenhuma'}
                    </div>
                  )}
                  {draft.bikeActivity?.label && (
                    <span className="pillar-subtext">{draft.bikeActivity.label}</span>
                  )}
                </div>
              </div>

              {/* Gym Workout Card */}
              <div className="summary-pillar-card">
                <div className="pillar-header">
                  <div className="pillar-icon pillar-gym">
                    <Dumbbell size={16} />
                  </div>
                  <strong>Musculação</strong>
                </div>
                <div className="pillar-body">
                  <div className="gym-group-selector">
                    {(['A', 'B', 'C'] as const).map((grp) => (
                      <button
                        key={grp}
                        type="button"
                        className={`gym-grp-btn ${
                          draft.gymWorkout?.group === grp ? 'active' : ''
                        }`}
                        onClick={() =>
                          handleUpdateWorkoutGroup(draft.gymWorkout?.group === grp ? null : grp)
                        }
                      >
                        Treino {grp}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Summary Action Buttons */}
            <div className="summary-actions-bar">
              <button
                type="button"
                className="summary-cancel-btn"
                onClick={handleCancel}
                aria-label="Cancelar e descartar rascunho"
              >
                <X size={16} />
                <span>Cancelar</span>
              </button>

              <button
                type="button"
                className="summary-confirm-btn"
                onClick={handleConfirm}
                disabled={isSubmitting}
                aria-label="Confirmar e registrar no Hoje"
              >
                <Check size={16} />
                <span>Confirmar e Registrar</span>
              </button>
            </div>
          </div>
        )}

        {/* Chat Input Bar */}
        <div className="chat-input-bar">
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            placeholder={
              draft
                ? 'Digite para ajustar o rascunho ou adicione mais informações...'
                : 'Ex: Fui de bike 2,5 km, almocei 130g de lombo e 100g de arroz, treinei o A...'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            rows={2}
            aria-label="Mensagem para o Diário IA"
          />

          <button
            type="button"
            className="chat-send-btn"
            onClick={() => handleSendMessage()}
            disabled={isLoading || !input.trim()}
            title="Enviar narração"
            aria-label="Enviar mensagem"
          >
            <Send size={18} />
          </button>
        </div>
      </section>
    </div>
  )
}
