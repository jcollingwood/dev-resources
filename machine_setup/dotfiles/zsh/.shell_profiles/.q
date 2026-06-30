
# pipe question through to ollama  
q() {
  setopt local_options nomonitor
  local model="gemma4:12b"
  local prompt="Answer in one or two sentences, no preamble:"
  local q="$*"

  local green=$'\033[38;2;166;227;161m'   # Green  #a6e3a1
  local yellow=$'\033[38;2;249;226;175m'  # Yellow #f9e2af
  local peach=$'\033[38;2;250;179;135m'   # Peach  #fab387
  local teal=$'\033[38;2;148;226;213m'    # Teal   #94e2d5
  local mauve=$'\033[38;2;203;166;247m'   # Mauve  #cba6f7
  local overlay=$'\033[38;2;108;112;134m' # Overlay1 (muted gray) #6c7086

  local bar=$teal
  local text=$yellow
  local gray=$overlay
  local reset=$'\033[0m'
  echo ""

  # run the request in the background, capture output to a temp file
  local tmpfile=$(mktemp)
  (curl -s http://fedora:11434/api/chat -d "$(jq -n --arg m "$model" --arg p "$q" '{
    model: $m,
    messages: [{role: "user", content: "${prompt} \($p)"}],
    stream: false,
    think: false,
    options: {num_predict: 200, temperature: 0.3}
  }')" | jq -r '.message.content' > "$tmpfile") &
  local pid=$!
  
  # echo "${bar}┃${reset} ${gray}${model}"

  # spinner
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  tput civis  # hide cursor
  while kill -0 $pid 2>/dev/null; do
    i=$(( (i+1) % ${#spin} ))
    printf "\r${bar}┃${reset} ${text}%s thinking...${reset}" "${spin:$i:1}"
    sleep 0.08
  done
  printf "\r\033[K"  # clear the spinner line
  tput cnorm  # restore cursor

  local answer=$(cat "$tmpfile")
  rm -f "$tmpfile"

  echo "$answer" | fold -s -w 76 | sed "s/^/${bar}┃${reset} ${text}/"
  echo -n "$reset"
}

