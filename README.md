# Sound Direction Estimation using Machine Learning and TinyML
### Summer Research Internship Programme (SRIP 2025–26)
**Institution:** NMAM Institute of Technology, Nitte (Deemed to be University)  
**Student:** Hithesh H G (Department of Computer Science & Engineering)  
**Faculty Guide:** Dr. Keerthana B Chigateri  
**Department Coordinator:** Dr. Rajalaxmi Hegde  

---

### Project Phasing & Research Methodology:
1. **Stage 1 (Current Implementation):** Classical DSP Baseline via Generalized Cross-Correlation with Phase Transform (GCC-PHAT) and Time Difference of Arrival (TDOA) on a synchronized dual-microphone MEMS array.
2. **Stage 2 (Dataset Generation):** Automated logging of acoustic feature vectors (GCC-PHAT cross-correlation sequences, Interaural Time/Phase Differences) paired with ground-truth DOA angles.
3. **Stage 3 (Machine Learning & TinyML Deployment):** Training a quantized lightweight neural network (1D-CNN / MLP) deployed using TensorFlow Lite for Microcontrollers (TFLM) to estimate sound direction robustly in reverberant and noisy edge environments.

---

## 1. Hardware Architecture & Wiring

* **Microcontroller:** ESP32 DevKit (`ESP32-D0WD-V3`)
* **Microphones:** 2 × INMP441 Omnidirectional I2S Digital MEMS Microphones
* **Microphone Spacing ($d$):** `0.15 m` (15 cm, configurable in code)
* **Bus Architecture:** Both microphones share the exact same I2S clock (`SCK`), word-select (`WS`), and data (`SD`) lines.

### Wiring Table

| Signal | ESP32 GPIO | MIC 1 (Left Channel) | MIC 2 (Right Channel) | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **VDD** | 3.3V | VDD | VDD | Power supply |
| **GND** | GND | GND | GND | Common ground |
| **SCK** (BCLK) | **GPIO 26** | SCK | SCK | Continuous bit clock |
| **WS** (LRCLK) | **GPIO 25** | WS | WS | Left/Right word select |
| **SD** (DIN) | **GPIO 33** | SD | SD | Shared multiplexed data line |
| **L/R** | — | **GND** | **3.3V** | Tri-state channel select |

> **How Shared SD Multiplexing Works:**  
> When `WS` is LOW, the Left microphone (L/R tied to GND) drives the 24-bit audio data onto GPIO 33 while the Right microphone places its output in high-impedance (tri-state). When `WS` is HIGH, the Right microphone (L/R tied to 3.3V) drives the bus while the Left microphone tri-states.

---

## 2. Mathematical Foundation & Physics

### A. Generalized Cross-Correlation with Phase Transform (GCC-PHAT)
Traditional cross-correlation between microphone signals $x_1[n]$ and $x_2[n]$ is sensitive to room reverberation and spectral coloration. GCC-PHAT overcomes this by normalizing the cross-power spectrum by its magnitude, preserving **only the phase delay**:

1. **Windowing & Forward FFT:**
   $$\tilde{x}_1[n] = (x_1[n] - \mu_1) \cdot w[n], \quad \tilde{x}_2[n] = (x_2[n] - \mu_2) \cdot w[n]$$
   $$X_1[k] = \text{FFT}(\tilde{x}_1), \quad X_2[k] = \text{FFT}(\tilde{x}_2)$$
   where $w[n]$ is a 512-point Hann window and $\mu$ is the DC bias.

2. **Cross-Power Spectral Density (CPSD):**
   $$G_{12}[k] = X_1[k] \cdot X_2^*[k]$$

3. **Phase Transform (PHAT) Weighting:**
   $$G_{\text{PHAT}}[k] = \frac{G_{12}[k]}{|G_{12}[k]| + \epsilon}$$
   where $\epsilon = 10^{-6}$ prevents division by zero in quiet frequency bins.

4. **Inverse FFT (IFFT) & Peak Detection:**
   $$R_{12}[\tau] = \text{IFFT}(G_{\text{PHAT}})$$
   $$\tau_{\text{peak}} = \arg\max_{\tau \in [-\tau_{\max}, +\tau_{\max}]} R_{12}[\tau]$$

### B. Time Difference of Arrival (TDOA)
$$\text{TDOA} = \frac{\tau_{\text{peak}}}{F_s} \quad (\text{seconds})$$
$$\text{TDOA}_{\mu\text{s}} = \text{TDOA} \times 10^6 \quad (\mu\text{s})$$

### C. Direction of Arrival (DOA) / Angle Estimation
Assuming a planar wavefront in the acoustic far-field ($r \gg d$):
$$\sin\theta = \frac{c \cdot \text{TDOA}}{d}$$
$$\theta = \arcsin\left(\operatorname{clamp}\left(\frac{c \cdot \text{TDOA}}{d}, -1.0, 1.0\right)\right)$$

where:
* $c = 343.0\text{ m/s}$ (speed of sound in dry air at $\approx 20^\circ\text{C}$)
* $d = 0.15\text{ m}$ (microphone baseline spacing)
* $F_s = 16000\text{ Hz}$ (sampling rate)

---

## 3. Angle Convention & Acoustic Boundaries

```
                 0° (Broadside / Center)
                       ▲
                       │
       -45°            │            +45°
           \           │           /
            \          │          /
             \         │         /
  -90° ◄──────[MIC 1]──┴──[MIC 2]──────► +90°
  (Left)         d = 0.15 m              (Right)
```

| Source Location | Physical Delay | TDOA (samples) | TDOA ($\mu\text{s}$) | Estimated Angle ($\theta$) |
| :--- | :--- | :--- | :--- | :--- |
| **Directly at MIC 1 (Left Endfire)** | Sound hits MIC 1 first | **-7 samples** | **-437.5 $\mu\text{s}$** | **-90.0°** |
| **Left Sector** | MIC 1 earlier than MIC 2 | **-3 samples** | **-187.5 $\mu\text{s}$** | **-25.4°** |
| **Broadside (Center / Perpendicular)** | Equidistant to both mics | **0 samples** | **0.0 $\mu\text{s}$** | **0.0°** |
| **Right Sector** | MIC 2 earlier than MIC 1 | **+3 samples** | **+187.5 $\mu\text{s}$** | **+25.4°** |
| **Directly at MIC 2 (Right Endfire)** | Sound hits MIC 2 first | **+7 samples** | **+437.5 $\mu\text{s}$** | **+90.0°** |

### Maximum Physical Lag Window
Because sound cannot travel faster than $343\text{ m/s}$, the maximum possible acoustic delay between two microphones spaced $15\text{ cm}$ apart is:
$$\tau_{\max} = \frac{d \cdot F_s}{c} = \frac{0.15 \times 16000}{343} \approx 6.997 \rightarrow \mathbf{7\text{ samples}}$$
The peak search is strictly constrained to $\tau \in [-7, +7]$. Any peak outside this window is an impossible acoustic delay (such as late room reverberation or ambient multipath) and is automatically filtered out.

---

## 4. Arduino IDE Setup & Compilation

1. Open **Arduino IDE**.
2. Open `soundEstimation.ino` (`File > Open...`).
3. Select your ESP32 board:
   * **Board:** `ESP32 Dev Module` (or your specific ESP32 board).
   * **Flash Frequency:** `80MHz`.
   * **CPU Frequency:** `240MHz (WiFi/BT)`.
   * **Upload Speed:** `921600` or `115200`.
4. **No External FFT Library Required:**  
   The sketch includes a self-contained, single-precision Radix-2 Cooley-Tukey FFT/IFFT engine optimized for the ESP32 hardware FPU. This avoids the breaking API changes between `arduinoFFT` v1.x and v2.x.
5. Click **Upload** and open the **Serial Monitor** at **115200 baud**.

---

## 5. Step-by-Step Testing Procedure

### Step 1: Channel Verification (Tapping Test)
1. Open the Serial Monitor at 115200 baud.
2. Gently tap the casing of **MIC 1 (Left)**.
   * `LEFT RMS` should spike significantly higher than `RIGHT RMS`.
3. Gently tap the casing of **MIC 2 (Right)**.
   * `RIGHT RMS` should spike significantly higher than `LEFT RMS`.
4. *If the channels appear reversed:* Open `soundEstimation.ino` and set:
   ```cpp
   #define SWAP_MIC_CHANNELS true
   ```

### Step 2: Testing Sound in the Center (Broadside)
* **Action:** Snap fingers or clap your hands directly in front of the center point between MIC 1 and MIC 2 (approx. 30–50 cm away along the perpendicular center line).
* **Expected Serial Output:**
  ```text
  LEFT RMS: 24150
  RIGHT RMS: 23980
  TDOA: 0 samples
  TDOA: 0.0 us
  ANGLE: 0.0 degrees
  [STATUS: VALID | Peak: 0.92 | SNR: 5.4x]
  ```

### Step 3: Testing Sound near MIC 1 (Left Sector)
* **Action:** Clap or speak near the left side of the array (closer to MIC 1, approx. 45° to the left).
* **Expected Serial Output:**
  ```text
  LEFT RMS: 31200
  RIGHT RMS: 22400
  TDOA: -3 samples
  TDOA: -187.5 us
  ANGLE: -25.4 degrees
  [STATUS: VALID | Peak: 0.88 | SNR: 4.9x]
  ```

### Step 4: Testing Sound near MIC 2 (Right Sector)
* **Action:** Clap or speak near the right side of the array (closer to MIC 2, approx. 45° to the right).
* **Expected Serial Output:**
  ```text
  LEFT RMS: 21800
  RIGHT RMS: 32600
  TDOA: 3 samples
  TDOA: 187.5 us
  ANGLE: 25.4 degrees
  [STATUS: VALID | Peak: 0.87 | SNR: 4.8x]
  ```

---

## 6. Reliability & Diagnostics (Handling Invalid Results)

GCC-PHAT normalizes the cross-power spectrum by its magnitude ($G / |G|$). On pure background noise or in highly reverberant environments, this whitening can produce random phase spikes. The firmware employs 3 stages of validation:

1. **Silence / Noise Floor Rejection (`RMS_NOISE_THRESHOLD = 1200.0f`):**
   * If `rms_left` or `rms_right` is below threshold, the window is classified as `IDLE / SILENCE`.
   * No false angle or random correlation noise is reported.
2. **Weak Correlation Peak Rejection (`MIN_PEAK_THRESHOLD = 0.15f`):**
   * If the cross-correlation peak magnitude is too low, the signal lacks coherent direct-path acoustic energy.
   * Flagged as `UNRELIABLE (Weak correlation peak)`.
3. **Diffuse Noise / Flat Peak Rejection (`PEAK_RATIO_THRESHOLD = 2.2f`):**
   * Computes the ratio of the peak correlation value to the mean correlation across the physical lag window:
     $$\text{SNR}_{\text{peak}} = \frac{\max(R_{12})}{\operatorname{mean}(|R_{12}|)}$$
   * If diffuse noise or room reverberation creates multiple equal-amplitude reflections, this ratio drops below `2.2x`.
   * Flagged as `UNRELIABLE (Diffuse noise / Flat peak)`.

---

## 7. Dataset Collection for TinyML

To collect training and validation data for the upcoming TinyML model:

1. In `soundEstimation.ino`, set:
   ```cpp
   #define CSV_OUTPUT_MODE true
   ```
2. Upload the sketch. The serial monitor will output clean CSV rows:
   ```csv
   timestamp_ms,left_rms,right_rms,tdoa_samples,tdoa_us,angle_deg,status,peak_val
   12500,24150.0,23980.0,0.00,0.0,0.0,VALID,0.920
   13000,31200.0,22400.0,-3.00,-187.5,-25.4,VALID,0.880
   ```
3. Capture the stream directly to a `.csv` file via terminal or PuTTY:
   ```powershell
   # In Windows PowerShell:
   [System.IO.Ports.SerialPort]::getportnames()
   # Or using Python:
   python -m serial.tools.miniterm COM3 115200 > dataset.csv
   ```
This provides labeled ground-truth TDOA and angles generated by this DSP baseline to train and benchmark the TinyML neural network.
