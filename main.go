package main

import (
	"encoding/json"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type TempData struct {
	BoilerCoilIn  float64 `json:"boiler_coil_in"`
	DhwOut        float64 `json:"dhw_out"`
	HeatingReturn float64 `json:"heating_return"`
	HeatingSupply float64 `json:"heating_supply"`
	FloorReturn   float64 `json:"floor_return"`
}

type SensorTracker struct {
	lastValid     float64
	hasValid      bool
	errorSince    time.Time
	isSensorError bool
}

func (st *SensorTracker) Update(raw float64) float64 {
	// Проверяем на код ошибки DS18B20 (-127.0 с учетом погрешности float)
	if math.Abs(raw-(-127.0)) < 0.01 {
		if st.errorSince.IsZero() {
			st.errorSince = time.Now()
		}
		// Если сбой длится >= 1 минуты, возвращаем -127.0 (флаг ошибки)
		if time.Since(st.errorSince) >= time.Minute {
			st.isSensorError = true
			return -127.0
		}
		// Если минута не прошла и есть старое валидное значение — возвращаем его
		if st.hasValid {
			return st.lastValid
		}
		return -127.0
	}

	// Датчик прислал нормальные данные — сбрасываем таймер ошибки
	st.errorSince = time.Time{}
	st.isSensorError = false
	st.lastValid = raw
	st.hasValid = true
	return raw
}

type AppConfig struct {
	Port         string
	ESP32URL     string
	PollInterval time.Duration
}

type TempStore struct {
	mu       sync.RWMutex
	data     TempData
	hasData  bool
	trackers map[string]*SensorTracker
}

func NewTempStore() *TempStore {
	return &TempStore{
		trackers: map[string]*SensorTracker{
			"boiler_coil_in": {},
			"dhw_out":        {},
			"heating_return": {},
			"heating_supply": {},
			"floor_return":   {},
		},
	}
}

func (s *TempStore) Set(raw TempData) TempData {
	s.mu.Lock()
	defer s.mu.Unlock()

	processed := TempData{
		BoilerCoilIn:  s.trackers["boiler_coil_in"].Update(raw.BoilerCoilIn),
		DhwOut:        s.trackers["dhw_out"].Update(raw.DhwOut),
		HeatingReturn: s.trackers["heating_return"].Update(raw.HeatingReturn),
		HeatingSupply: s.trackers["heating_supply"].Update(raw.HeatingSupply),
		FloorReturn:   s.trackers["floor_return"].Update(raw.FloorReturn),
	}

	s.data = processed
	s.hasData = true
	return processed
}

func (s *TempStore) Get() (TempData, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data, s.hasData
}

func loadConfigFromINI(filename string) AppConfig {
	cfg := AppConfig{
		Port:         "8080",
		ESP32URL:     "http://192.168.1",
		PollInterval: 5 * time.Second,
	}

	data, err := os.ReadFile(filename)
	if err != nil {
		if os.IsNotExist(err) {
			defaultContent := "[server]\n" +
				"port = " + cfg.Port + "\n\n" +
				"[esp32]\n" +
				"url = " + cfg.ESP32URL + "\n" +
				"poll_interval = 5s\n"
			if writeErr := os.WriteFile(filename, []byte(defaultContent), 0644); writeErr != nil {
				log.Printf("Не удалось создать %s: %v", filename, writeErr)
			} else {
				log.Printf("Создан файл конфигурации %s со значениями по умолчанию", filename)
			}
		} else {
			log.Printf("Ошибка чтения %s (%v), используем настройки по умолчанию", filename, err)
		}
		return cfg
	}

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "[") {
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])

			switch key {
			case "port":
				if val != "" {
					cfg.Port = val
				}
			case "url":
				cfg.ESP32URL = val
			case "poll_interval":
				if d, parseErr := time.ParseDuration(val); parseErr == nil && d >= time.Second {
					cfg.PollInterval = d
				}
			}
		}
	}

	return cfg
}

func loadOrInitTempJSON(filename string, store *TempStore) {
	data, err := os.ReadFile(filename)
	if err != nil {
		if os.IsNotExist(err) {
			initial := TempData{}
			saveTempJSON(filename, initial)
			log.Printf("Создан файл данных %s со стартовыми значениями", filename)
		}
		return
	}

	var temps TempData
	if err := json.Unmarshal(data, &temps); err == nil {
		store.Set(temps)
	}
}

func saveTempJSON(filename string, temps TempData) {
	data, err := json.MarshalIndent(temps, "", "  ")
	if err != nil {
		return
	}
	data = append(data, '\n')
	_ = os.WriteFile(filename, data, 0644)
}

func startESP32Poller(url string, interval time.Duration, store *TempStore, backupFile string) {
	client := &http.Client{
		Timeout: 3 * time.Second,
		Transport: &http.Transport{
			DisableKeepAlives: true,
		},
	}

	fetch := func() {
		resp, err := client.Get(url)
		if err != nil {
			log.Printf("Ошибка опроса ESP32 (%s): %v", url, err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			log.Printf("ESP32 вернул статус %d", resp.StatusCode)
			return
		}

		body, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
		if err != nil {
			log.Printf("Ошибка чтения ответа ESP32: %v", err)
			return
		}

		var rawTemps TempData
		if err := json.Unmarshal(body, &rawTemps); err != nil {
			log.Printf("Ошибка разбора JSON от ESP32: %v", err)
			return
		}

		processedTemps := store.Set(rawTemps)
		saveTempJSON(backupFile, processedTemps)
	}

	fetch()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for range ticker.C {
		fetch()
	}
}

func makeTempsHandler(store *TempStore, localFile string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if temps, ok := store.Get(); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			json.NewEncoder(w).Encode(temps)
			return
		}

		data, err := os.ReadFile(localFile)
		if err != nil {
			http.Error(w, "Нет данных с датчиков", http.StatusServiceUnavailable)
			return
		}

		var temps TempData
		if err := json.Unmarshal(data, &temps); err != nil {
			http.Error(w, "Ошибка формата JSON", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(temps)
	}
}

func main() {
	cfg := loadConfigFromINI("conf.ini")
	store := NewTempStore()

	loadOrInitTempJSON("temp.json", store)

	if cfg.ESP32URL != "" {
		log.Printf("Запуск опроса ESP32 по адресу %s (интервал: %v)", cfg.ESP32URL, cfg.PollInterval)
		go startESP32Poller(cfg.ESP32URL, cfg.PollInterval, store, "temp.json")
	} else {
		log.Printf("URL ESP32 не задан, работаем в режиме чтения локального temp.json")
	}

	addr := ":" + strings.TrimPrefix(cfg.Port, ":")

	mux := http.NewServeMux()
	mux.HandleFunc("/api/temps", makeTempsHandler(store, "temp.json"))
	mux.Handle("/", getWebHandler())

	log.Printf("Сервер запущен на http://localhost%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
