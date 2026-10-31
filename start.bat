@echo off
echo ===================================================
echo     Menjalankan OptiPixel di http://localhost:8080
echo ===================================================
start "" "http://localhost:8080"
python -m http.server 8080
