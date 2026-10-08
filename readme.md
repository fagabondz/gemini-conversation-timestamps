# Gemini Conversation Timestamps - Chrome Extension

[![Trakteer](https://img.shields.io/badge/Support_me_on-Trakteer-e74c3c?style=flat&logo=buymeacoffee&logoColor=white)](https://trakteer.id/fagabond)
[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/fagabond)

Ekstensi Chrome sederhana untuk Google Gemini (`gemini.google.com`). Ekstensi ini menambahkan *tooltip* kecil saat kursor diarahkan (*hover*) ke riwayat percakapan di sidebar, menampilkan informasi tanggal dan jam percakapan dibuat serta kapan terakhir kali diubah.

---

## Tampilan & Format Tooltip

Saat kursor diarahkan ke salah satu percakapan di sidebar, akan muncul *popup* dengan format:

```text
dibuat: 02:30 07/10/26
diedit: 07:40 09/10/26
```

- **dibuat**: Waktu dan tanggal saat percakapan pertama kali dibuat.
- **diedit**: Waktu dan tanggal terakhir kali ada pesan yang dikirim/diterima pada percakapan tersebut.

---

## Fitur Utama

1. **Ringan & Cepat**
   - Ditulis murni menggunakan Vanilla JavaScript tanpa tambahan library atau framework.
   - Ukuran keseluruhan ekstensi sangat kecil (kurang dari 20 KB).
   - Menggunakan teknik *Event Delegation* untuk meminimalkan penggunaan memori, sehingga tidak membuat browser terasa berat.

2. **Sinkronisasi Data**
   - Mendukung `chrome.storage.sync`. Jika Anda login dengan akun Google yang sama di Chrome pada perangkat lain, data waktu percakapan akan otomatis tersinkronisasi.
   - Menggunakan `chrome.storage.local` sebagai cadangan agar data tetap tersimpan saat sedang offline atau kuota sinkronisasi penuh.

3. **Fokus pada Privasi & Keamanan**
   - Dibangun dengan standar **Manifest V3**.
   - **Tanpa akses server luar**: Ekstensi ini tidak mengirimkan data analitik atau data pengguna apa pun ke server pihak ketiga. Semua data diproses dan disimpan secara lokal di browser.
   - Menerapkan *Strict Isolation* dan hanya meminta izin yang benar-benar dibutuhkan (`storage` dan akses spesifik ke `https://gemini.google.com/*`).

---

## Cara Memasang di Google Chrome (Developer Mode)

Karena ekstensi ini belum diunggah ke Chrome Web Store, Anda bisa memasangnya secara manual dengan langkah-langkah berikut:

1. Unduh *source code* ekstensi ini (berupa file ZIP) dan ekstrak ke dalam sebuah folder di komputer Anda.
2. Buka browser **Google Chrome**.
3. Ketik alamat berikut di *address bar* dan tekan Enter:
   ```text
   chrome://extensions
   ```
4. Di pojok kanan atas, aktifkan *toggle* **Developer mode**.
5. Klik tombol **Load unpacked** yang muncul di pojok kiri atas.
6. Cari dan pilih folder hasil ekstrak tadi (pastikan Anda memilih folder yang langsung berisi file `manifest.json`).
7. Selesai! Buka atau *refresh* tab **[Google Gemini](https://gemini.google.com)** untuk melihat ekstensi bekerja.

---

## Struktur File

```text
ekstensi-gemini/
├── manifest.json       # Konfigurasi utama Manifest V3
├── interceptor.js      # Script untuk menangkap data waktu dari API Gemini
├── content.js          # Script utama: mengelola cache, storage, dan merender tooltip
├── styles.css          # Styling tooltip agar responsif dengan tema gelap/terang
├── popup.html          # Tampilan antarmuka saat ikon ekstensi di-klik
├── popup.js            # Logika untuk menampilkan status dan jumlah data tersimpan
├── icons/              # Aset ikon ekstensi
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md           # Dokumentasi ekstensi
```
