# Gemini Conversation Timestamps - Chrome Extension

Ekstensi Chrome super ringan dan aman untuk Google Gemini (`gemini.google.com`). Ekstensi ini menambahkan popup kecil (tooltip) saat mengarahkan kursor mouse (hover) ke judul percakapan di sidebar Gemini, menampilkan tanggal & jam pembuatan serta waktu terakhir percakapan berinteraksi.

---

## 🎯 Tampilan & Format Tooltip

Saat Anda mengarahkan kursor (hover) ke percakapan di sidebar, popup kecil akan muncul dengan format:

```text
dibuat: 02:30 07/10/26
diedit: 07:40 09/10/26
```

- **dibuat**: Waktu dan tanggal saat percakapan pertama kali dibuat.
- **diedit**: Waktu dan tanggal terakhir interaksi / pesan dikirim pada percakapan tersebut.
- Teks tersusun rapi dua baris (baris `diedit` berada tepat di bawah baris `dibuat`).

---

## ⚡ Fitur Utama

1. **Super Ringan & Tanpa Beban**:
   - Dibuat dengan 100% Vanilla JavaScript murni tanpa library/framework eksternal.
   - Ukuran total file ekstensi sangat kecil (< 20 KB).
   - Menggunakan teknik **Event Delegation** (hanya 1 passive event listener pada dokumen, bukan ratusan di tiap elemen).
   - Penggunaan RAM & CPU mendekati 0%, tidak membuat PC atau laptop lemot saat browsing.

2. **Sinkronisasi Otomatis Antar Perangkat**:
   - Memanfaatkan **`chrome.storage.sync`**. Saat Anda login dengan akun Google yang sama di Chrome pada PC atau laptop lain, seluruh data waktu & tanggal percakapan akan otomatis tersinkronisasi.
   - Dilengkapi sistem cadangan **`chrome.storage.local`** sehingga data tetap aman tersimpan saat offline atau kuota sync sedang penuh.

3. **Keamanan Maksimal (Enterprise-Grade Security)**:
   - **Manifest V3**: Mengikuti standar ekstensi Chrome terbaru dan paling aman.
   - **Zero External Network Requests**: Ekstensi tidak mengirim data apa pun ke server pihak ketiga atau server eksternal. Semua data tetap berada di browser Anda.
   - **Anti-XSS / Anti-Injection**: Tooltip dibangun murni menggunakan DOM `textContent` dan manipulasi elemen aman, sehingga kebal terhadap serangan Cross-Site Scripting (XSS).
   - **Least Privilege**: Hanya meminta izin `storage` dan akses ke host `https://gemini.google.com/*`. Tidak meminta izin sensitif seperti pembacaan tab umum, cookie, ataupun riwayat browsing.
   - **Strict Isolation**: Pemisahan eksekusi antara konteks interceptor (`MAIN` world) dan ekstensi (`ISOLATED` world) dengan validasi origin dan tipe pesan yang ketat.

---

## 🚀 Cara Memasang di Google Chrome

1. Buka browser **Google Chrome**.
2. Masuk ke halaman ekstensi dengan mengetikkan alamat berikut di bilah URL:
   ```text
   chrome://extensions
   ```
3. Di pojok kanan atas, aktifkan tombol **"Developer mode"** (Mode Pengembang).
4. Klik tombol **"Load unpacked"** (Muat yang belum dibongkar) di pojok kiri atas.
5. Pilih folder ekstensi ini:
   ```text
   C:\Users\Anriani\Desktop\ekstensi-gemini
   ```
6. Ekstensi langsung aktif! Buka atau muat ulang (refresh) tab **[Gemini](https://gemini.google.com)**.
7. Arahkan mouse ke judul percakapan mana saja di sidebar untuk melihat tanggal dan jam dibuat serta diedit.

---

## 📂 Struktur File

```text
ekstensi-gemini/
├── manifest.json       # Konfigurasi Manifest V3
├── interceptor.js      # Interceptor API Gemini (MAIN world, run_at document_start)
├── content.js          # Skrip utama: cache, sinkronisasi storage, dan hover tooltip
├── styles.css          # Desain tooltip ringan dan adaptif tema gelap/terang
├── popup.html          # Tampilan mini saat mengklik ikon ekstensi di toolbar
├── popup.js            # Logika ringkasan status & jumlah percakapan tersimpan
├── icons/              # Ikon ekstensi resolusi 16x16, 48x48, 128x128
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md           # Panduan lengkap ekstensi
```
