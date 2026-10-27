import React, { useMemo } from 'react'
import { Bike, Check, Droplets, Dumbbell, Flame, Zap } from 'lucide-react'

export interface DayActivityData {
  workoutDone: boolean
  nutritionDone: boolean
  waterDone: boolean
  bikeDone: boolean
}

interface ConsistencySectionProps {
  currentDateStr: string
  getActivityForDate: (dateStr: string) => DayActivityData
  streakCount: number
  weeklyGoalTarget?: number
  onSelectDate?: (dateStr: string) => void
}

const toISO = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export const ConsistencySection: React.FC<ConsistencySectionProps> = ({
  currentDateStr,
  getActivityForDate,
  streakCount,
  weeklyGoalTarget = 5,
  onSelectDate,
}) => {
  const weekDays = (() => {
    const today = new Date(`${currentDateStr}T12:00:00`)
    const monday = new Date(today)
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
    const labels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']
    return labels.map((label, index) => {
      const date = new Date(monday)
      date.setDate(monday.getDate() + index)
      const iso = toISO(date)
      return { label, dayNumber: date.getDate(), iso, isCurrent: iso === currentDateStr, activity: getActivityForDate(iso) }
    })
  })()

  const workouts = useMemo(() => weekDays.filter((day) => day.activity.workoutDone).length, [weekDays])
  const heatmapDays = (() => {
    const base = new Date(`${currentDateStr}T12:00:00`)
    return Array.from({ length: 28 }, (_, index) => {
      const date = new Date(base)
      date.setDate(base.getDate() - (27 - index))
      const iso = toISO(date)
      const activity = getActivityForDate(iso)
      const score = Number(activity.workoutDone) + Number(activity.nutritionDone) + Number(activity.waterDone) + Number(activity.bikeDone)
      return { iso, dayNum: date.getDate(), score, isCurrent: iso === currentDateStr }
    })
  })()

  const color = (score: number) => score === 1 ? 'heat-blue-1' : score === 2 ? 'heat-blue-2' : score === 3 ? 'heat-blue-3' : score === 4 ? 'heat-blue-4' : 'heat-blue-0'
  const indicators = [
    { key: 'workoutDone' as const, label: 'Treino', Icon: Dumbbell, active: 'indicator-workout' },
    { key: 'nutritionDone' as const, label: 'Nutrição', Icon: Flame, active: 'indicator-nutrition' },
    { key: 'waterDone' as const, label: 'Hidratação', Icon: Droplets, active: 'indicator-water' },
    { key: 'bikeDone' as const, label: 'Bike', Icon: Bike, active: 'indicator-bike' },
  ]

  return (
    <section className="consistency-section" aria-label="Consistência e histórico">
      <div className="consistency-summary">
        <article className="consistency-stat">
          <div className="consistency-stat-label"><Zap aria-hidden="true"/><span>Sequência</span></div>
          <div className="consistency-stat-value">{streakCount}<small>{streakCount === 1 ? 'dia' : 'dias seguidos'}</small></div>
        </article>
        <article className="consistency-stat">
          <div className="consistency-stat-label"><Dumbbell aria-hidden="true"/><span>Meta semanal</span></div>
          <div className="consistency-stat-value">{workouts}<small>/ {weeklyGoalTarget} treinos</small></div>
        </article>
      </div>

      <article className="consistency-card">
        <header className="consistency-card-header"><b>Atividade da semana</b><span>Seg — Dom</span></header>
        <div className="training-week">
          {weekDays.map((day) => (
            <button key={day.iso} type="button" onClick={() => onSelectDate?.(day.iso)} className={`training-day ${day.isCurrent ? 'training-day-current' : ''}`} aria-label={`${day.label} ${day.dayNumber}`}>
              <span className="training-day-label">{day.label}</span><strong>{day.dayNumber}</strong>
              <span className="training-indicators">{indicators.map(({ key, label, Icon, active }) => (
                <span key={key} className={`training-indicator ${day.activity[key] ? active : ''}`} title={label} aria-label={`${label}: ${day.activity[key] ? 'concluído' : 'pendente'}`}><Icon aria-hidden="true"/></span>
              ))}</span>
              {day.iso === currentDateStr && <Check className="current-day-check" aria-hidden="true"/>}
            </button>
          ))}
        </div>
      </article>

      <article className="consistency-card">
        <header className="consistency-card-header"><b>Consistência · últimos 28 dias</b><span className="heat-legend"><small>Menos</small>{[0, 1, 2, 3, 4].map((score) => <i key={score} className={`heat-cell ${color(score)}`} aria-hidden="true"/>)}<small>Mais</small></span></header>
        <div className="consistency-heatmap">
          {heatmapDays.map((day) => <div key={day.iso} title={`${day.iso}: ${day.score}/4 pilares`} className={`heat-cell ${color(day.score)} ${day.isCurrent ? 'heat-current' : ''}`}><span>{day.dayNum}</span></div>)}
        </div>
      </article>
    </section>
  )
}
