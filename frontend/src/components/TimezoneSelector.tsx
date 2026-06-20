import { useTimezone } from '../context/TimezoneProvider';

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export function TimezoneSelector() {
  const { timezone, setTimezone } = useTimezone();

  // Get all available timezones from the browser
  let allTimezones: string[];
  try {
    allTimezones = Intl.supportedValuesOf('timeZone');
  } catch {
    allTimezones = COMMON_TIMEZONES;
  }

  return (
    <div className="timezone-selector">
      <label htmlFor="timezone-select">Timezone: </label>
      <select
        id="timezone-select"
        value={timezone}
        onChange={(e) => setTimezone(e.target.value)}
        aria-label="Select display timezone"
      >
        <optgroup label="Common">
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
          ))}
        </optgroup>
        <optgroup label="All Timezones">
          {allTimezones
            .filter((tz) => !COMMON_TIMEZONES.includes(tz))
            .map((tz) => (
              <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
            ))}
        </optgroup>
      </select>
    </div>
  );
}
