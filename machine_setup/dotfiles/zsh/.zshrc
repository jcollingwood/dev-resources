#if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
#  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
#fi

export ZSH="$HOME/.oh-my-zsh"

# Standard plugins can be found in $ZSH/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
plugins=(
	git
	asdf
)

# alias to connect to local raspberrypi
alias sshpi='ssh pi@raspberrypi.local'
# note: if using nonstandard port add -p 1234 to ssh command

# include(): source if exists
include () {
	[[ -f "$1" ]] && source "$1"
}
source $ZSH/oh-my-zsh.sh
include $HOME/.shell_profiles/.barrel
include $HOME/.shell_profiles/.env

# . ~/.asdf/plugins/java/set-java-home.zsh

# alias for starting kanata with config with custom key mappings
alias kanata="sudo ~/.cargo/bin/kanata -c ~/.config/kanata/config.kbd"

# autocorrect package alias
eval $(thefuck --alias fix)

source <(fzf --zsh)

# p10k theme, must be at end of .zshrc
# source ~/powerlevel10k/powerlevel10k.zsh-theme
# [[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh
# POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD=true

# to switch to starship instead of p10k
eval "$(starship init zsh)"

#THIS MUST BE AT THE END OF THE FILE FOR SDKMAN TO WORK!!!
export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"

# opencode
export PATH=/home/joel/.opencode/bin:$PATH

# opencode
export PATH=/home/joel/bin:$PATH

# Added by LM Studio CLI (lms)
export PATH="$PATH:/home/joel/.lmstudio/bin"
# End of LM Studio CLI section

