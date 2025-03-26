# Use an official Node base image that has apt-get
FROM node:18

# Install Python & pip, so we can install yt-dlp
RUN apt-get update && apt-get install -y python3 python3-pip

# Install yt-dlp
RUN pip3 install yt-dlp

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if any)
COPY package*.json ./

# Install NPM dependencies
RUN npm install

# Copy the rest of the source code
COPY . .

# Expose the port your app runs on (assuming it's 3000)
EXPOSE 3000

# Start the app
CMD ["npm", "start"]