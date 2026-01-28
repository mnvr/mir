export const formatLocalTimestamp = (date: Date) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const pad = (value: number) => value.toString().padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const tz = `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )} ${date.getFullYear()} ${tz}`
}

const LOCAL_TIMESTAMP_PATTERN =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) \d{2}:\d{2}:\d{2} (\d{4})/

type LocalTimestampParts = {
  weekdayShort: string
  monthShort: string
  day: number
  year: number
}

const formatOrdinalDate = (day: number) => {
  const mod100 = day % 100
  if (mod100 >= 11 && mod100 <= 13) {
    return `${day}th`
  }
  const mod10 = day % 10
  if (mod10 === 1) {
    return `${day}st`
  }
  if (mod10 === 2) {
    return `${day}nd`
  }
  if (mod10 === 3) {
    return `${day}rd`
  }
  return `${day}th`
}

export const parseLocalTimestampDate = (
  localTimestamp: string,
): LocalTimestampParts | null => {
  const match = localTimestamp.match(LOCAL_TIMESTAMP_PATTERN)
  if (!match) {
    return null
  }
  const day = Number(match[3])
  const year = Number(match[4])
  if (!Number.isFinite(day) || !Number.isFinite(year)) {
    return null
  }
  return {
    weekdayShort: match[1],
    monthShort: match[2],
    day,
    year,
  }
}

export const formatLocalTimestampHeading = (localTimestamp?: string) => {
  if (!localTimestamp) {
    return null
  }
  const parsed = parseLocalTimestampDate(localTimestamp)
  if (!parsed) {
    return null
  }
  return `${parsed.weekdayShort} ${parsed.monthShort} ${formatOrdinalDate(
    parsed.day,
  )}, ${parsed.year}`
}
