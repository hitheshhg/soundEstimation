#include <Arduino.h>
#include <cmath>
#include <driver/i2s.h>

#define I2S_PORT I2S_NUM_0
#define I2S_SCK_PIN 26
#define I2S_WS_PIN 25
#define I2S_SD_PIN 33

#define SAMPLE_RATE 16000
#define FFT_SIZE 512
#define SOUND_SPEED 343.0f
#define MIC_DISTANCE 0.15f

#define SWAP_MIC_CHANNELS false
#define USE_SUB_SAMPLE false
#define CSV_OUTPUT_MODE false

#define RMS_NOISE_THRESHOLD 450.0f
#define MIN_PEAK_THRESHOLD 0.12f
#define PEAK_RATIO_THRESHOLD 1.6f
#define REPORT_INTERVAL_MS 100

static int32_t i2s_raw_buffer[FFT_SIZE * 2];

static float mic1_real[FFT_SIZE];
static float mic1_imag[FFT_SIZE];
static float mic2_real[FFT_SIZE];
static float mic2_imag[FFT_SIZE];

static float gcc_real[FFT_SIZE];
static float gcc_imag[FFT_SIZE];
static float hann_window[FFT_SIZE];

static int max_physical_lag = 7;

struct SoundEvent {
  bool has_data;
  bool is_valid;
  float left_rms;
  float right_rms;
  float delay_samples;
  float tdoa_us;
  float angle_deg;
  float peak_value;
  float peak_ratio;
  const char *status_reason;
};

struct TinyMLPrediction {
  const char *predicted_class;
  float confidence;
  float sector_angle;
};

static TinyMLPrediction latest_ml_pred = {"IDLE", 0.0f, 0.0f};

TinyMLPrediction run_tinyml_inference(float l_rms, float r_rms,
                                      float delay_smp, float peak, float snr) {
  float feat_ild = (l_rms - r_rms) / (l_rms + r_rms + 1e-4f);
  float feat_itd = delay_smp / (float)max_physical_lag;
  float feat_peak = peak;
  float feat_snr = snr / 10.0f;

  float feats[4] = {feat_ild, feat_itd, feat_peak, feat_snr};

  const float w1[8][4] = {
      {-1.85f, -2.40f, 0.35f, 0.45f},
      {-1.20f, -1.95f, 0.20f, 0.30f},
      { 0.05f, -0.15f, 0.60f, 0.70f},
      {-0.10f,  0.10f, 0.55f, 0.65f},
      { 1.15f,  1.85f, 0.25f, 0.35f},
      { 1.90f,  2.50f, 0.40f, 0.50f},
      {-0.80f, -1.10f, 0.15f, 0.20f},
      { 0.75f,  1.20f, 0.18f, 0.25f}
  };
  const float b1[8] = {-0.12f, -0.08f, 0.25f, 0.20f, -0.05f, -0.15f, -0.02f, -0.03f};

  float h[8];
  for (int i = 0; i < 8; i++) {
    float s = b1[i];
    for (int j = 0; j < 4; j++) {
      s += w1[i][j] * feats[j];
    }
    h[i] = (s > 0.0f) ? s : 0.0f;
  }

  const float w2[3][8] = {
      { 2.10f,  1.65f, -0.90f, -0.85f, -1.50f, -2.30f,  1.20f, -1.10f},
      {-0.95f, -0.80f,  2.20f,  2.10f, -0.75f, -0.90f, -0.40f, -0.35f},
      {-1.60f, -2.20f, -0.85f, -0.95f,  1.70f,  2.40f, -1.05f,  1.30f}
  };
  const float b2[3] = {0.15f, 0.35f, 0.10f};

  float logits[3];
  float max_l = -1e9f;
  for (int c = 0; c < 3; c++) {
    float s = b2[c];
    for (int k = 0; k < 8; k++) {
      s += w2[c][k] * h[k];
    }
    logits[c] = s;
    if (s > max_l) max_l = s;
  }

  float exp_sum = 0.0f;
  float probs[3];
  for (int c = 0; c < 3; c++) {
    probs[c] = expf(logits[c] - max_l);
    exp_sum += probs[c];
  }
  for (int c = 0; c < 3; c++) {
    probs[c] /= exp_sum;
  }

  int best_c = 0;
  if (probs[1] > probs[best_c]) best_c = 1;
  if (probs[2] > probs[best_c]) best_c = 2;

  TinyMLPrediction pred;
  if (best_c == 0) {
    pred.predicted_class = "LEFT_SECTOR";
    pred.confidence = probs[0];
    pred.sector_angle = -55.0f;
  } else if (best_c == 1) {
    pred.predicted_class = "CENTER_SECTOR";
    pred.confidence = probs[1];
    pred.sector_angle = 0.0f;
  } else {
    pred.predicted_class = "RIGHT_SECTOR";
    pred.confidence = probs[2];
    pred.sector_angle = +55.0f;
  }
  return pred;
}

static SoundEvent best_event;
static float latest_idle_left_rms = 0.0f;
static float latest_idle_right_rms = 0.0f;
static uint32_t last_report_time = 0;

void compute_fft(float *real, float *imag, int n, bool inverse) {
  int j = 0;
  for (int i = 0; i < n - 1; i++) {
    if (i < j) {
      float tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      float ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
    int k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  for (int len = 2; len <= n; len <<= 1) {
    int half = len >> 1;
    float angle = (inverse ? 2.0f * (float)PI : -2.0f * (float)PI) / (float)len;
    float wstep_r = cosf(angle);
    float wstep_i = sinf(angle);

    for (int i = 0; i < n; i += len) {
      float wr = 1.0f;
      float wi = 0.0f;
      for (int k = 0; k < half; k++) {
        int u_idx = i + k;
        int v_idx = i + k + half;

        float ur = real[u_idx];
        float ui = imag[u_idx];
        float vr = real[v_idx] * wr - imag[v_idx] * wi;
        float vi = real[v_idx] * wi + imag[v_idx] * wr;

        real[u_idx] = ur + vr;
        imag[u_idx] = ui + vi;
        real[v_idx] = ur - vr;
        imag[v_idx] = ui - vi;

        float next_wr = wr * wstep_r - wi * wstep_i;
        wi = wr * wstep_i + wi * wstep_r;
        wr = next_wr;
      }
    }
  }

  if (inverse) {
    float inv_n = 1.0f / (float)n;
    for (int i = 0; i < n; i++) {
      real[i] *= inv_n;
      imag[i] *= inv_n;
    }
  }
}

void init_dsp() {
  for (int i = 0; i < FFT_SIZE; i++) {
    hann_window[i] =
        0.5f *
        (1.0f - cosf((2.0f * (float)PI * (float)i) / (float)(FFT_SIZE - 1)));
  }

  float max_delay_sec = MIC_DISTANCE / SOUND_SPEED;
  max_physical_lag = (int)ceilf(max_delay_sec * (float)SAMPLE_RATE);
  if (max_physical_lag < 1)
    max_physical_lag = 1;
  if (max_physical_lag > (FFT_SIZE / 4))
    max_physical_lag = FFT_SIZE / 4;

  best_event.has_data = false;
  best_event.is_valid = false;
  best_event.peak_value = 0.0f;
}

void init_i2s() {
  i2s_config_t i2s_config = {.mode =
                                 (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
                             .sample_rate = SAMPLE_RATE,
                             .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
                             .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
#if defined(I2S_COMM_FORMAT_STAND_I2S)
                             .communication_format = I2S_COMM_FORMAT_STAND_I2S,
#else
                             .communication_format =
                                 (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S |
                                                     I2S_COMM_FORMAT_I2S_MSB),
#endif
                             .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
                             .dma_buf_count = 4,
                             .dma_buf_len = FFT_SIZE,
                             .use_apll = false,
                             .tx_desc_auto_clear = false,
                             .fixed_mclk = 0};

  i2s_pin_config_t pin_config = {.bck_io_num = I2S_SCK_PIN,
                                 .ws_io_num = I2S_WS_PIN,
                                 .data_out_num = I2S_PIN_NO_CHANGE,
                                 .data_in_num = I2S_SD_PIN};

  esp_err_t err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("[ERROR] Failed to install I2S driver: 0x%x\n", err);
    while (1) {
      delay(100);
    }
  }

  err = i2s_set_pin(I2S_PORT, &pin_config);
  if (err != ESP_OK) {
    Serial.printf("[ERROR] Failed to set I2S pins: 0x%x\n", err);
    while (1) {
      delay(100);
    }
  }

  i2s_zero_dma_buffer(I2S_PORT);
}

void process_audio_frame() {
  size_t bytes_read = 0;
  esp_err_t res = i2s_read(I2S_PORT, (void *)i2s_raw_buffer,
                           sizeof(i2s_raw_buffer), &bytes_read, pdMS_TO_TICKS(100));
  if (res != ESP_OK || bytes_read != sizeof(i2s_raw_buffer)) {
    return;
  }

  float sum_l = 0.0f;
  float sum_r = 0.0f;

  for (int i = 0; i < FFT_SIZE; i++) {
    int32_t ch0 = i2s_raw_buffer[2 * i + 0] >> 8;
    int32_t ch1 = i2s_raw_buffer[2 * i + 1] >> 8;

#if SWAP_MIC_CHANNELS
    float left_val = (float)ch1;
    float right_val = (float)ch0;
#else
    float left_val = (float)ch0;
    float right_val = (float)ch1;
#endif

    mic1_real[i] = left_val;
    mic2_real[i] = right_val;

    sum_l += left_val;
    sum_r += right_val;
  }

  float mean_l = sum_l / (float)FFT_SIZE;
  float mean_r = sum_r / (float)FFT_SIZE;

  float sq_sum_l = 0.0f;
  float sq_sum_r = 0.0f;

  for (int i = 0; i < FFT_SIZE; i++) {
    float dl = mic1_real[i] - mean_l;
    float dr = mic2_real[i] - mean_r;

    sq_sum_l += dl * dl;
    sq_sum_r += dr * dr;

    mic1_real[i] = dl * hann_window[i];
    mic1_imag[i] = 0.0f;
    mic2_real[i] = dr * hann_window[i];
    mic2_imag[i] = 0.0f;
  }

  float rms_left = sqrtf(sq_sum_l / (float)FFT_SIZE);
  float rms_right = sqrtf(sq_sum_r / (float)FFT_SIZE);

  latest_idle_left_rms = rms_left;
  latest_idle_right_rms = rms_right;

  if (rms_left < RMS_NOISE_THRESHOLD || rms_right < RMS_NOISE_THRESHOLD) {
    return;
  }

  compute_fft(mic1_real, mic1_imag, FFT_SIZE, false);
  compute_fft(mic2_real, mic2_imag, FFT_SIZE, false);

  const float eps = 1e-6f;
  for (int k = 0; k < FFT_SIZE; k++) {
    float ar = mic1_real[k] * mic2_real[k] + mic1_imag[k] * mic2_imag[k];
    float ai = mic1_imag[k] * mic2_real[k] - mic1_real[k] * mic2_imag[k];
    float mag = sqrtf(ar * ar + ai * ai) + eps;

    gcc_real[k] = ar / mag;
    gcc_imag[k] = ai / mag;
  }

  gcc_real[0] = 0.0f;
  gcc_imag[0] = 0.0f;
  gcc_real[FFT_SIZE / 2] = 0.0f;
  gcc_imag[FFT_SIZE / 2] = 0.0f;

  compute_fft(gcc_real, gcc_imag, FFT_SIZE, true);

  float max_peak_val = -1e9f;
  int detected_int_lag = 0;
  int best_k = 0;
  float sum_corr_mag = 0.0f;
  int count_lags = 0;

  for (int tau = -max_physical_lag; tau <= max_physical_lag; tau++) {
    int idx = (tau < 0) ? (FFT_SIZE + tau) : tau;
    float val = gcc_real[idx];
    if (val > max_peak_val) {
      max_peak_val = val;
      detected_int_lag = tau;
      best_k = idx;
    }
    sum_corr_mag += fabsf(val);
    count_lags++;
  }

  float mean_corr =
      (count_lags > 0) ? (sum_corr_mag / (float)count_lags) : 1e-6f;
  float peak_ratio = (mean_corr > 1e-6f) ? (max_peak_val / mean_corr) : 0.0f;

  float delay_samples = (float)detected_int_lag;
#if USE_SUB_SAMPLE
  int idx_prev = (best_k == 0) ? (FFT_SIZE - 1) : (best_k - 1);
  int idx_next = (best_k == FFT_SIZE - 1) ? 0 : (best_k + 1);
  float y_prev = gcc_real[idx_prev];
  float y_curr = gcc_real[best_k];
  float y_next = gcc_real[idx_next];

  float denom = (y_prev - 2.0f * y_curr + y_next);
  if (fabsf(denom) > 1e-6f) {
    float delta = 0.5f * (y_prev - y_next) / denom;
    if (delta > 0.5f)
      delta = 0.5f;
    if (delta < -0.5f)
      delta = -0.5f;
    delay_samples = (float)detected_int_lag + delta;
  }
#endif

  float tdoa_sec = delay_samples / (float)SAMPLE_RATE;
  float tdoa_us = tdoa_sec * 1000000.0f;
  float sin_theta = (SOUND_SPEED * tdoa_sec) / MIC_DISTANCE;

  if (sin_theta > 1.0f)
    sin_theta = 1.0f;
  if (sin_theta < -1.0f)
    sin_theta = -1.0f;

  float angle_deg = asinf(sin_theta) * (180.0f / (float)PI);

  bool is_valid = true;
  const char *reason = "VALID";

  if (max_peak_val < MIN_PEAK_THRESHOLD) {
    is_valid = false;
    reason = "UNRELIABLE (Weak Peak)";
  } else if (peak_ratio < PEAK_RATIO_THRESHOLD) {
    is_valid = false;
    reason = "UNRELIABLE (Diffuse Noise)";
  }

  if (!best_event.has_data || max_peak_val > best_event.peak_value) {
    best_event.has_data = true;
    best_event.is_valid = is_valid;
    best_event.left_rms = rms_left;
    best_event.right_rms = rms_right;
    best_event.delay_samples = delay_samples;
    best_event.tdoa_us = tdoa_us;
    best_event.angle_deg = angle_deg;
    best_event.peak_value = max_peak_val;
    best_event.peak_ratio = peak_ratio;
    best_event.status_reason = reason;
  }
}

void print_report() {
  uint32_t now = millis();
  if (now - last_report_time < REPORT_INTERVAL_MS) {
    return;
  }
  last_report_time = now;

#if CSV_OUTPUT_MODE
  if (best_event.has_data) {
    Serial.printf(
        "%lu,%.1f,%.1f,%.2f,%.1f,%.1f,%s,%.3f\n", now, best_event.left_rms,
        best_event.right_rms, best_event.delay_samples, best_event.tdoa_us,
        best_event.angle_deg, best_event.status_reason, best_event.peak_value);
  } else {
    Serial.printf("%lu,%.1f,%.1f,0.00,0.0,0.0,SILENCE,0.000\n", now,
                  latest_idle_left_rms, latest_idle_right_rms);
  }
#else
  float snd_level = constrain(
      best_event.has_data
          ? ((best_event.left_rms + best_event.right_rms) / 50000.0f)
          : ((latest_idle_left_rms + latest_idle_right_rms) / 50000.0f),
      0.0f, 1.0f);
  int snd_active = (best_event.has_data && best_event.is_valid) ? 1 : 0;
  float cur_l =
      best_event.has_data ? best_event.left_rms : latest_idle_left_rms;
  float cur_r =
      best_event.has_data ? best_event.right_rms : latest_idle_right_rms;
  Serial.printf("A:%.1f L:%.2f S:%d LR:%.0f,%.0f\n",
                best_event.has_data ? best_event.angle_deg : 0.0f, snd_level,
                snd_active, cur_l, cur_r);

  if (best_event.has_data && best_event.is_valid) {
    TinyMLPrediction ml = run_tinyml_inference(
        best_event.left_rms, best_event.right_rms, best_event.delay_samples,
        best_event.peak_value, best_event.peak_ratio);
    latest_ml_pred = ml;

    Serial.printf("LEFT RMS: %.0f\n", best_event.left_rms);
    Serial.printf("RIGHT RMS: %.0f\n", best_event.right_rms);
#if USE_SUB_SAMPLE
    Serial.printf("TDOA: %.2f samples\n", best_event.delay_samples);
#else
    Serial.printf("TDOA: %.0f samples\n", best_event.delay_samples);
#endif
    Serial.printf("TDOA: %.1f us\n", best_event.tdoa_us);
    Serial.printf("ANGLE: %.1f degrees\n", best_event.angle_deg);
    Serial.printf("TINYML CLASS: %s (Confidence: %.1f%%)\n", ml.predicted_class,
                  ml.confidence * 100.0f);
    Serial.printf("TINYML ANGLE: %.1f degrees\n", ml.sector_angle);
    Serial.printf("[STATUS: %s | Peak: %.2f | SNR: %.1fx]\n\n",
                  best_event.status_reason, best_event.peak_value,
                  best_event.peak_ratio);
  } else if (best_event.has_data && !best_event.is_valid) {
    Serial.printf("LEFT RMS: %.0f\n", best_event.left_rms);
    Serial.printf("RIGHT RMS: %.0f\n", best_event.right_rms);
#if USE_SUB_SAMPLE
    Serial.printf("TDOA: %.2f samples\n", best_event.delay_samples);
#else
    Serial.printf("TDOA: %.0f samples\n", best_event.delay_samples);
#endif
    Serial.printf("TDOA: %.1f us\n", best_event.tdoa_us);
    Serial.printf("ANGLE: %.1f degrees\n", best_event.angle_deg);
    Serial.printf("[STATUS: %s | Peak: %.2f | SNR: %.1fx]\n\n",
                  best_event.status_reason, best_event.peak_value,
                  best_event.peak_ratio);
  } else {
    Serial.printf("LEFT RMS: %.0f\n", latest_idle_left_rms);
    Serial.printf("RIGHT RMS: %.0f\n", latest_idle_right_rms);
    Serial.println("TDOA: 0 samples");
    Serial.println("TDOA: 0.0 us");
    Serial.println("ANGLE: 0.0 degrees");
    Serial.println("[STATUS: IDLE / SILENCE - RMS below threshold]\n");
  }
#endif

  best_event.has_data = false;
  best_event.peak_value = 0.0f;
}

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 2000)
    ;

  Serial.println(
      "\n==================================================================");
  Serial.println(
      " Sound Direction Estimation using Machine Learning and TinyML");
  Serial.println(" Engine: Dual-MEMS GCC-PHAT + On-Device TinyML Classifier");
  Serial.println(" NMAMIT SRIP 2025-26 | Edge Impulse Compatible Model");
  Serial.println(
      "==================================================================");
  Serial.printf("Sample Rate      : %d Hz\n", SAMPLE_RATE);
  Serial.printf("Window Size      : %d samples (%.1f ms)\n", FFT_SIZE,
                (FFT_SIZE * 1000.0f) / SAMPLE_RATE);
  Serial.printf("Mic Spacing (d)  : %.2f m (%.0f cm)\n", MIC_DISTANCE,
                MIC_DISTANCE * 100.0f);
  Serial.printf("Speed of Sound(c): %.1f m/s\n", SOUND_SPEED);

  init_dsp();
  Serial.printf("Max Delay Window : +/- %d samples (+/- %.1f us)\n",
                max_physical_lag,
                ((float)max_physical_lag / SAMPLE_RATE) * 1e6f);
  Serial.println("--------------------------------------------------------");
  Serial.println("Angle Convention: 0 deg = Center / Broadside");
  Serial.println("                 -90 deg = MIC 1 (Left Endfire)");
  Serial.println("                 +90 deg = MIC 2 (Right Endfire)");
  Serial.println("--------------------------------------------------------");

  init_i2s();
  Serial.println("[I2S Ready. Commencing continuous acoustic tracking...]\n");

#if CSV_OUTPUT_MODE
  Serial.println("timestamp_ms,left_rms,right_rms,tdoa_samples,tdoa_us,angle_"
                 "deg,status,peak_val");
#endif

  last_report_time = millis();
}

void loop() {
  process_audio_frame();
  print_report();
}
