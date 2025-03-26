# Use a Node base image
FROM node:18

# Install Python and pip
RUN apt-get update && apt-get install -y python3 python3-pip

# Install yt-dlp globally
RUN pip3 install yt-dlp

# (Optional) confirm the binary is accessible
RUN ln -s /usr/local/bin/yt-dlp /usr/bin/yt-dlp

WORKDIR /app

# Copy your Node files and install
COPY package*.json ./
RUN npm install

# Copy in the rest of your code
COPY . .

# Build (if needed)
# RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]