# Independent of Node.js and Playwright. Uses the macOS system Ruby.
require 'json'
require 'time'
require 'net/http'
require 'uri'
File.umask(0077)
ROOT = File.join(Dir.home, 'Library/Application Support/GymMonitor')

def read_json(name)
  JSON.parse(File.read(File.join(ROOT, name)))
rescue Errno::ENOENT
  {}
end

def save_json(name, value)
  target = File.join(ROOT, name)
  File.write(target + '.tmp', JSON.generate(value), mode: 'w', perm: 0600)
  File.rename(target + '.tmp', target)
end

def timestamp(value)
  Time.iso8601(value).to_f
rescue ArgumentError, TypeError
  0
end

def subscribers(config)
  control = read_json('telegram-control.json')
  recipients = (control['subscribers'] || {}).dup
  owner = config['telegramChatId'].to_s
  recipients[owner] ||= { 'mutedUntil' => control['mutedUntil'] } unless owner.empty?
  recipients
end

def notify(text, chat_id, config)
  ENV['TZ'] = config.fetch('timezone', 'Asia/Ho_Chi_Minh')
  hour = Time.now.hour
  return false unless hour >= config.fetch('startHour', 9) && hour < config.fetch('endHour', 20)
  token = config['telegramToken']
  raise 'credentials unavailable' unless token.to_s.match?(/\A\d+:[A-Za-z0-9_-]+\z/) && !chat_id.empty?
  uri = URI('https://api.telegram.org/bot' + token + '/sendMessage')
  request = Net::HTTP::Post.new(uri)
  request['Content-Type'] = 'application/json'
  request.body = JSON.generate(chat_id: chat_id, text: text,
    reply_markup: { inline_keyboard: [[{ text: '🏋️ Уже сходил — выключить на сегодня', callback_data: 'gym:stop' }]] })
  http = Net::HTTP.new(uri.host, uri.port, nil)
  http.use_ssl = true
  http.open_timeout = 10
  http.read_timeout = 15
  response = http.request(request)
  raise 'delivery failed' unless response.is_a?(Net::HTTPSuccess) && JSON.parse(response.body)['ok']
  true
end

def run
  enabled = read_json('watchdog-enabled.json')
  return if enabled.empty?
  now = Time.now.to_f
  state = read_json('watchdog-state.json')
  state = { 'generation' => enabled['since'] } if state['generation'] != enabled['since']
  # Sleep, logout and a disabled watchdog are not monitoring time.
  if now - state.fetch('lastRun', 0) > 600 || now < state.fetch('lastRun', 0)
    state['awakeSince'] = now
  end
  state['lastRun'] = now
  since = timestamp(enabled['since'])
  heartbeat = timestamp(read_json('heartbeat.json')['completedAt'])
  fatal = read_json('fatal.json')
  baseline = [since, heartbeat].max
  loaded = system('/bin/launchctl', 'print', "gui/#{Process.uid}/local.gym-monitor", out: File::NULL, err: File::NULL)
  issue = if timestamp(fatal['checkedAt']) > baseline
            'Проверка аварийно завершилась. Подробности: fatal.json и launchd-errors.log.'
          elsif !loaded
            'Задание мониторинга отсутствует в launchd. Запустите настройку заново.'
          elsif now - [baseline, state.fetch('awakeSince', now)].max > 45 * 60
            'Более 45 минут нет завершённых проверок. Проверьте Node.js и журнал launchd-errors.log.'
          end
  # Persist wake timing even if Telegram is temporarily unreachable.
  save_json('watchdog-state.json', state)
  config = read_json('watchdog-config.json')
  state['recipients'] ||= {}
  subscribers(config).each do |chat_id, subscriber|
    next if timestamp(subscriber['mutedUntil']) > now
    prior = state['recipients'][chat_id] ||= (chat_id == config['telegramChatId'].to_s ?
      { 'notified' => state['notified'], 'alertedAt' => state['alertedAt'] } : {})
    begin
      if issue && !prior['notified']
        next unless notify("⚠️ GymMonitor: #{issue}", chat_id, config)
        prior['notified'] = true
        prior['alertedAt'] = now
      elsif !issue && prior['notified'] && heartbeat > [since, prior.fetch('alertedAt', 0)].max
        next unless notify('✅ GymMonitor: проверки возобновились.', chat_id, config)
        prior['notified'] = false
      end
    rescue StandardError
      # One unavailable recipient must not block delivery to the others.
      warn JSON.generate(at: Time.now.utc.iso8601, status: 'watchdog_delivery_failed')
    end
  end
  save_json('watchdog-state.json', state)
end

begin
  Dir.mkdir(ROOT, 0700) unless Dir.exist?(ROOT)
  File.open(File.join(ROOT, 'watchdog.lock'), File::RDWR | File::CREAT, 0600) do |lock|
    run if lock.flock(File::LOCK_EX | File::LOCK_NB)
  end
rescue StandardError => error
  # Never print raw errors: HTTP exceptions may expose bot credentials.
  warn JSON.generate(at: Time.now.utc.iso8601, status: 'watchdog_error', type: error.class.name)
  exit 1
end
