@echo off
REM Inicia um servidor local e abre o app no navegador.
REM Para testar no celular (mesma rede Wi-Fi), acesse http://IP-DO-COMPUTADOR:5500
cd /d "%~dp0"
start "" http://localhost:5500
python -m http.server 5500
