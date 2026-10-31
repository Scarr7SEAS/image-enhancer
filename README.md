# OptiPixel - Client-Side Pixel Enhancer & Super-Resolution Upscaler

Aplikasi web modern untuk meningkatkan resolusi foto (1x, 2x, 3x, 4x) dan melakukan rekonstruksi pixel secara mendalam **100% langsung di browser pengguna (Client-Side)**. Dapat di-hosting secara gratis di Netlify tanpa butuh server GPU, database, atau kartu kredit.

---

## 🌟 Fitur Utama

- **Fokus Rekonstruksi Pixel (Bukan Filter Wajah Palsu)**:
  - Mengembalikan ketajaman teks, tepi objek, garis arsitektur, dan tekstur kain.
  - Bebas efek halusinasi AI wajah atau penghalusan kulit berlebihan.
- **Pilihan Skala Upscaling Multi-Tingkat**:
  - **1x**: Enhance Saja (perbaikan pixel tanpa mengubah dimensi gambar).
  - **2x**: Rekomendasi seimbang (resolusi 4x lipat).
  - **3x**: Detail tinggi (resolusi 9x lipat).
  - **4x**: Maksimal super-resolution (resolusi 16x lipat).
- **Algoritma Canggih & Bebas Halo**:
  - **AMD Contrast Adaptive Sharpening (CAS)**: Menajamkan kontur pixel secara proporsional tanpa menghasilkan lingkaran putih atau over-sharpening halo.
  - **Fast Catmull-Rom Bicubic Filtering**: Rekonstruksi interpolasi halus pada diagonal.
  - **Bilateral Pixel Denoising**: Menghilangkan artefak blok JPEG dan noise ISO kamera.
  - **Micro-Contrast & Detail Recovery**: Mengangkat tekstur mikro dan kejelasan objek.
- **Optimasi Khusus Chrome HP & Perangkat RAM Rendah**:
  - **Adaptive Tiling Architecture**: Gambar berukuran besar dipecah menjadi ubin-ubin kecil yang diproses bergantian dengan jeda eksekusi UI thread. Mencegah browser crash, Out-Of-Memory (OOM), ataupun pesan "Halaman tidak merespons" pada Chrome Android/iOS.
  - **Dynamic Viewport Height**: Menggunakan `100dvh` agar tata letak tidak berantakan saat address bar Chrome ponsel muncul atau hilang.
  - **No Input Auto-Zoom**: Seluruh input diatur minimal 16px untuk mencegah mobile browser auto-zoom.
  - **Touch Friendly**: Tombol dan tuas geser dioptimalkan untuk sentuhan jari (minimal 44px).
- **Inspektor Interaktif & Perbandingan**:
  - **Geser Belah (Split Slider)**: Geser tuas kiri-kanan untuk melihat perbedaan langsung foto asli vs hasil perbaikan.
  - **Berdampingan (Side-by-Side)**: Tampilan dua panel sejajar.
  - **Tahan Banding (Blink)**: Tahan untuk melihat foto asli, lepas untuk melihat hasil.
  - **Zoom & Pan**: Tombol Fit, 1:1 (100%), 2:1 (200%), serta drag pan untuk melihat susunan pixel secara detail.
- **Dukungan Batch & Format Output Fleksibel**:
  - Proses banyak foto sekaligus.
  - Unduh perorangan atau Unduh Semua sebagai satu file ZIP (menggunakan JSZip).
  - Pilihan format: PNG (Lossless), WebP (Ukuran hemat kualitas tinggi), JPG (dengan slider kompresi kualitas).
  - Tombol Salin ke Clipboard (langsung sebagai PNG).
- **PWA (Progressive Web App)**:
  - Dapat di-install ke layar utama ponsel Android/iOS seperti aplikasi native.
  - Dukungan offline via Service Worker (`sw.js`).
- **Tema Gelap & Terang**:
  - Toggle cepat dengan palet warna modern dan kontras nyaman di mata.

---

## 🚀 Panduan Hosting di Netlify

OptiPixel dirancang 100% statis (HTML5, WebGL, Canvas, JavaScript) sehingga dapat di-deploy ke Netlify dalam hitungan detik secara gratis:

### Cara 1: Drag & Drop (Paling Mudah)
1. Buka [app.netlify.com](https://app.netlify.com) dan login ke akun Netlify Anda.
2. Buka tab **Sites**.
3. Tarik (*drag & drop*) folder `image-enhancer` ke kotak deploy Netlify.
4. Selesai! Web Anda langsung aktif dan memiliki link publik HTTPS.

### Cara 2: Hubungkan ke GitHub
1. Buat repository baru di GitHub (misal: `Scarr7SEAS/image-enhancer`).
2. Masukkan file di folder `image-enhancer` ke git:
   ```bash
   git init
   git add .
   git commit -m "Initial commit OptiPixel"
   git branch -M main
   git remote add origin https://github.com/Scarr7SEAS/image-enhancer.git
   git push -u origin main
   ```
3. Di dashboard Netlify, klik **Add new site** &rarr; **Import an existing project** &rarr; pilih GitHub &rarr; pilih repo `image-enhancer`.
4. Pengaturan build:
   - **Build command**: *(kosongkan)*
   - **Publish directory**: `.` *(atau kosongkan)*
5. Klik **Deploy Site**. Setiap kali Anda push ke GitHub, Netlify akan otomatis memperbarui web Anda.

---

## 💻 Menjalankan Secara Lokal

Cukup jalankan file `start.bat` dengan mengklik dua kali, atau gunakan terminal:
```bash
python -m http.server 8080
```
Buka browser di `http://localhost:8080`.

---

## 🛡️ Jaminan Privasi

Aplikasi ini tidak memiliki server backend pemrosesan. Foto yang dimasukkan diproses langsung di memori RAM dan GPU perangkat Anda sendiri. Tidak ada data gambar yang dikirim keluar atau disimpan di cloud mana pun.
