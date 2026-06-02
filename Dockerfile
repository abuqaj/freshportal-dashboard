FROM python:3.12-slim

WORKDIR /app

COPY python/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Chromium + all system dependencies required by Playwright
RUN playwright install chromium --with-deps

COPY python/ .

EXPOSE 8000

CMD ["python", "api_server.py"]
